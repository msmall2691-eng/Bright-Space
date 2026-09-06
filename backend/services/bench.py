"""The bench: everyone who can work, and everything the office needs about them.

WHY THIS EXISTS. The subcontractor surface shipped in eight phases and landed
in three unrelated places: applications inside Settings > Users, the document
review nested in a disclosure on a row of the staff list, and the weekly digest
on the Ops Board. Nothing anywhere answered the question the office actually
asks, which is "who have I got, and can they work". Turno — the product this
bench is modelled on — puts exactly one screen in front of a host: the cleaner,
their badges, their history. This is that screen.

ONE REQUEST DRAWS IT (brightbase-economy). Six queries for the whole bench, not
six per person: the roster's three, one bounded pass over jobs, one over open
claim requests, one over payouts. `roster()` already had the file half and is
reused rather than reimplemented, so the two screens cannot drift into
disagreeing about whether somebody is cleared.

WHAT IS DELIBERATELY NOT COUNTED HERE, and this is the load-bearing part:

  - **Declines.** The signed agreement, section 2: "You can decline anything,
    for any reason or none... Declining does not count against you and does not
    affect what you are offered next." A decline-rate column would be the app
    contradicting the contract the sub signed, on screen, where the office
    makes decisions. JobResponse rows still exist; nothing here aggregates
    them.

  - **Punctuality from clock punches.** Control of the means and progress of
    the work is Part 1 #1 of the Maine standard, and it is one of the two
    criteria this arrangement satisfies by design. Measuring a contractor's
    arrival time against a schedule is supervision of hours. The time clock
    stays what it is — the employee payroll path, which still runs beside this
    one.

What IS counted is outcomes, which a customer of a business may fairly look at:
work finished, whether it was finished on the day it was booked for, when they
last worked, and what they are already holding. Nothing here ranks or picks —
see the marketplace skill's Rule 0. It is a roster with facts on it.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Job, JobClaimRequest, SubPayout, User
from services.sub_vetting import roster
from utils.dates import business_date, business_today, coerce_date

# How far back the work history looks. Long enough that a monthly-ish sub still
# shows a number, short enough that "completed" means recently rather than ever.
HISTORY_DAYS = 90


def _crew_key(job) -> list:
    """Job.cleaner_ids is JSON, so this joins in memory rather than in SQL.

    Filtering a JSON array server-side works differently on SQLite and Postgres
    and this is a bounded set — one org's jobs in a 90-day window plus what is
    upcoming. Same trade `roster()` makes for documents.
    """
    return [str(c) for c in (job.cleaner_ids or []) if c]


def build(db: Session, org_id: int) -> dict:
    """Everything the bench screen needs, in one payload."""
    today = business_today()
    since = today - timedelta(days=HISTORY_DAYS)

    base = roster(db, org_id)
    people = base["crew"]
    by_crew = {p["cleaner_id"]: p for p in people if p.get("cleaner_id")}
    by_user = {p["user_id"]: p for p in people}

    # ── work, from jobs ────────────────────────────────────────────────────
    #
    # completed_at is a UTC timestamp and scheduled_date is a business-local
    # date, so "did they finish it on the day it was booked" has to go through
    # business_date() before it means anything. Comparing them raw reads every
    # evening job as finished a day late.
    jobs = (db.query(Job)
            .filter(or_(Job.org_id == org_id, Job.org_id.is_(None)),
                    or_(Job.scheduled_date >= since, Job.completed_at.isnot(None)))
            .all())

    work = {cid: {"completed": 0, "on_day": 0, "upcoming": 0, "last_worked": None}
            for cid in by_crew}
    for j in jobs:
        finished = coerce_date(j.scheduled_date)
        for cid in _crew_key(j):
            w = work.get(cid)
            if w is None:
                continue
            if j.status == "completed":
                done = business_date(j.completed_at) or finished
                if done and done >= since:
                    w["completed"] += 1
                    if finished and done <= finished:
                        w["on_day"] += 1
                if done and (w["last_worked"] is None or done > w["last_worked"]):
                    w["last_worked"] = done
            elif finished and finished >= today and j.status not in ("cancelled", "skipped"):
                w["upcoming"] += 1

    # ── what they are already holding ──────────────────────────────────────
    holding: dict = {}
    for r in (db.query(JobClaimRequest)
              .filter(or_(JobClaimRequest.org_id == org_id,
                          JobClaimRequest.org_id.is_(None)),
                      JobClaimRequest.status == "pending").all()):
        holding[r.cleaner_id] = holding.get(r.cleaner_id, 0) + 1

    # ── money, this calendar year ──────────────────────────────────────────
    #
    # Not a vanity number: the 1099-NEC threshold is $600 and it is crossed
    # mid-year, not in January. Void rows are excluded — a voided payout was
    # never money.
    paid: dict = {}
    for p in (db.query(SubPayout)
              .filter(or_(SubPayout.org_id == org_id, SubPayout.org_id.is_(None)),
                      SubPayout.status != "void").all()):
        d = business_date(getattr(p, "created_at", None))
        if d and d.year == today.year:
            paid[p.user_id] = paid.get(p.user_id, 0.0) + (p.amount or 0.0)

    for p in people:
        w = work.get(p.get("cleaner_id")) or {
            "completed": 0, "on_day": 0, "upcoming": 0, "last_worked": None}
        p["work"] = {
            "completed": w["completed"],
            # Reported as a count beside the total, never as a lone percentage:
            # 1 of 1 is 100% and says nothing.
            "on_day": w["on_day"],
            "upcoming": w["upcoming"],
            "last_worked": w["last_worked"].isoformat() if w["last_worked"] else None,
            "pending_requests": holding.get(p.get("cleaner_id"), 0),
            "history_days": HISTORY_DAYS,
        }
        p["paid_ytd"] = round(paid.get(p["user_id"], 0.0), 2)
        # The 1099 you will owe them. Surfaced where you look at the person,
        # not in January when it is a scramble.
        p["form_1099_due"] = p["paid_ytd"] >= 600

    return {
        "people": people,
        "totals": {
            "people": len(people),
            "can_work": sum(1 for p in people if p["can_work"]),
            "awaiting_review": base["awaiting_review"],
            "incomplete": base["incomplete"],
            "blocked": base["blocked"],
            "form_1099_due": sum(1 for p in people if p["form_1099_due"]),
        },
        "enforce_from": base["enforce_from"],
        "history_days": HISTORY_DAYS,
    }
