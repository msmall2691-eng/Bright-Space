"""The bench, in one payload — what the Marketplace page reads.

WHY THIS EXISTS. The marketplace shipped as five surfaces bolted onto pages
that already existed: applicants and the roster on Crew, open jobs and waiting
requests on Schedule and the dashboard, standing work on Routes, money on
Payouts. Every piece worked and the owner could not find any of it — the first
question asked about it was "where can I view the marketplace page". A system
nobody can locate is not a shipped system.

So this is a HUB, not a sixth place to do the work. It answers "what is the
state of the bench and what is waiting on me", and every row links to the
screen that already owns that action. That restraint is deliberate and it is
partly a safety property: approving a claim request is the one path in the app
where "a sub requests, the office never assigns" is enforced, and a second
implementation of it is a second place to get worker classification wrong.

ONE REQUEST. Four sections, one fetch (brightbase-economy) — a hub that costs
four round trips to draw is worse than the five pages it replaces. The bench
half reuses `services/bench.build` rather than recomputing totals that would
then be free to disagree with the Crew screen.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import (Client, Job, JobClaimRequest, Property,
                             SubApplication, SubPayout, User)
from utils.dates import business_today

logger = logging.getLogger(__name__)

# Enough to see the shape of the queue without turning a hub into a list page.
# Anything past this is what the owning screen is for, and the count says so.
CAP = 8

# An application nobody has decided on yet. `reviewing` counts: somebody opened
# it and did not finish, which is exactly the state that goes quiet for a week.
WAITING_APPLICATION = ("new", "reviewing")


def _scope(model, org_id: int):
    return or_(model.org_id == org_id, model.org_id.is_(None))


def _iso(d) -> Optional[str]:
    return d.isoformat() if d else None


def build(db: Session, org_id: int, *, today: Optional[date] = None) -> dict:
    from services import bench

    today = today or business_today()

    # ── jobs open to the bench ──────────────────────────────────────────────
    #
    # `open_for_claims` AND nobody agreed yet. Approving a request writes
    # `agreed_cleaner_id` and closes the offer, so the second condition is
    # belt-and-braces — but a job showing as "open" after somebody already has
    # it is the one error on this page that would cost real money, and the
    # extra predicate is free.
    open_jobs = (db.query(Job)
                 .filter(_scope(Job, org_id),
                         Job.open_for_claims.is_(True),
                         Job.agreed_cleaner_id.is_(None),
                         Job.status == "scheduled",
                         Job.scheduled_date >= today)
                 .order_by(Job.scheduled_date, Job.id)
                 .all())

    job_ids = [j.id for j in open_jobs]
    asked: dict = {}
    # Who asked for each job, and at what price — so "Waiting on you" can be
    # triaged at a glance (name, ask, and a flag on a pushy one) without opening
    # every job. The hub still LINKS to the job to decide; it never approves
    # here (Rule 0: one approve path, the office never assigns).
    askers: dict = {}
    if job_ids:
        from services.standing_rules import claim_high_bid_flag_pct, is_high_bid
        flag_pct = claim_high_bid_flag_pct(db)
        posted_by_id = {j.id: j.posted_rate for j in open_jobs}
        reqs = (db.query(JobClaimRequest)
                .filter(_scope(JobClaimRequest, org_id),
                        JobClaimRequest.job_id.in_(job_ids),
                        JobClaimRequest.status == "pending")
                .order_by(JobClaimRequest.created_at)
                .all())
        # One query for the requester names rather than a lazy load each.
        cids = {r.cleaner_id for r in reqs if r.cleaner_id}
        cnames: dict = {}
        if cids:
            # Scope the name lookup to this org (BB-MT: a cleaner_id colliding
            # across tenants would otherwise surface another org's name on the
            # hub — every other query in build() is _scope'd, this one wasn't).
            #
            # _scope also admits legacy org_id IS NULL rows (they belong to the
            # default workspace — rls.py). For a NON-default tenant that shares
            # a cleaner_id with such a legacy user, that NULL row must not win
            # (or be picked nondeterministically) over the tenant's own user —
            # so resolve exact-org matches FIRST and never let a NULL homonym
            # overwrite one. The default org, whose own users may BE the NULL
            # rows, still resolves them (they're the only match).
            urows = (db.query(User)
                     .filter(_scope(User, org_id), User.cleaner_id.in_(cids))
                     .all())
            urows.sort(key=lambda u: 0 if u.org_id == org_id else 1)
            for u in urows:
                cnames.setdefault(u.cleaner_id, u.full_name or u.email)
        for r in reqs:
            asked[r.job_id] = asked.get(r.job_id, 0) + 1
            pr = posted_by_id.get(r.job_id)
            # A null counter means "I'll take your price" — surface the posted
            # rate as what they'd be paid, same as the office review row.
            rate = r.requested_rate if r.requested_rate is not None else pr
            askers.setdefault(r.job_id, []).append({
                "name": cnames.get(r.cleaner_id, r.cleaner_id),
                "rate": round(float(rate), 2) if rate is not None else None,
                "countered": r.requested_rate is not None,
                "high_bid": is_high_bid(r.requested_rate, pr, flag_pct),
            })

    # One query for the names rather than a lazy load per job.
    names: dict = {}
    towns: dict = {}
    if open_jobs:
        client_ids = {j.client_id for j in open_jobs if j.client_id}
        prop_ids = {j.property_id for j in open_jobs if j.property_id}
        if client_ids:
            names = {c.id: c.name for c in db.query(Client)
                     .filter(Client.id.in_(client_ids)).all()}
        if prop_ids:
            towns = {p.id: (p.city or None) for p in db.query(Property)
                     .filter(Property.id.in_(prop_ids)).all()}

    posted = [{
        "job_id": j.id,
        "title": j.title or f"Job #{j.id}",
        "client": names.get(j.client_id),
        "town": towns.get(j.property_id),
        "scheduled_date": _iso(j.scheduled_date),
        "posted_rate": round(float(j.posted_rate), 2) if j.posted_rate else None,
        "asked": asked.get(j.id, 0),
        # The people waiting on this one, so the office can size it up before
        # tapping through. Empty on a job nobody has asked for yet.
        "askers": askers.get(j.id, []),
    } for j in open_jobs]

    # Somebody has asked and is waiting on an answer. Sorted to the front of
    # the page because it is the only thing here where a person is blocked on
    # the office rather than the other way round.
    waiting_jobs = [p for p in posted if p["asked"]]

    # ── people asking to join ──────────────────────────────────────────────
    apps = (db.query(SubApplication)
            .filter(_scope(SubApplication, org_id),
                    SubApplication.status.in_(WAITING_APPLICATION))
            .order_by(SubApplication.created_at.desc())
            .all())

    # ── the bench itself ───────────────────────────────────────────────────
    #
    # Reused, not recomputed: two screens that both count "how many can work"
    # from different code will eventually disagree, and the one that is wrong
    # will be whichever the owner is looking at.
    roster = bench.build(db, org_id)
    totals = dict(roster.get("totals") or {})
    people = roster.get("people") or []

    # Direct deposit is not in the bench payload — it arrived with migration
    # 108 and belongs to the money half of this page, not the vetting half.
    user_ids = [p["user_id"] for p in people if p.get("user_id")]
    direct_deposit = 0
    if user_ids:
        direct_deposit = (db.query(User)
                          .filter(User.id.in_(user_ids),
                                  User.stripe_account_id.isnot(None),
                                  User.stripe_payouts_enabled.is_(True))
                          .count())

    # ── money owed and gone out ────────────────────────────────────────────
    #
    # `due` and `sent` are both still owed — the manual rail marks a payout
    # sent when the paperwork is produced, not when the money lands, so
    # collapsing them into "paid" is exactly the error the ledger exists to
    # prevent.
    owed = 0.0
    paid_ytd = 0.0
    for p in (db.query(SubPayout)
              .filter(_scope(SubPayout, org_id),
                      SubPayout.status.in_(("due", "sent", "paid")))
              .all()):
        amount = float(p.amount or 0.0)
        if p.status == "paid":
            if p.earned_on and p.earned_on.year == today.year:
                paid_ytd += amount
        else:
            owed += amount

    return {
        "today": today.isoformat(),
        "waiting": {
            "applications": [{
                "id": a.id,
                "name": a.name,
                "towns": a.towns,
                "created_at": _iso(a.created_at),
            } for a in apps[:CAP]],
            "application_count": len(apps),
            # Jobs where a person is waiting on an answer, and how many people.
            "jobs": waiting_jobs[:CAP],
            "job_count": len(waiting_jobs),
            "people_waiting": sum(p["asked"] for p in waiting_jobs),
        },
        "open_jobs": posted[:CAP],
        "open_job_count": len(posted),
        "bench": {
            "people": totals.get("people", 0),
            "can_work": totals.get("can_work", 0),
            "awaiting_review": totals.get("awaiting_review", 0),
            "blocked": totals.get("blocked", 0),
            "direct_deposit": direct_deposit,
        },
        "money": {
            "owed": round(owed, 2),
            "paid_ytd": round(paid_ytd, 2),
            "year": today.year,
        },
    }
