"""Crew push — "a job landed on your list", and "a job landed on the board."

Called from the canonical assignment write sites (scheduling's create_job /
update_job / auto-assign) AFTER the Job write commits, never from a background
tick (scheduling-invariants R1: event-driven, no polling). Delivery rides
services.push_service.notify_user, which is best-effort, opens its own
short-lived DB session, and is a silent no-op when VAPID keys aren't
configured — so a push hiccup can never fail or roll back the schedule write.

SECURITY: the payload carries only the day, time window, and property/job
name. Door codes, access notes, and addresses NEVER ride a push — lock-screen
notifications are world-readable and get mirrored to watches/other devices.
The cleaner opens My Day (the url target) for the real details.

An OFFER is stricter still, and for a different reason. The open-board listing
in modules/crew/router.py strips the customer's name, the property name and the
address, leaving town plus size: "whose house it is stops being the bidder's
business until they have actually won the job". A push that named the property
would hand back on a lock screen exactly what that listing withholds, to a
wider audience — so `_offer_line` is built from town, day and rate, and never
from `property.name`.
"""
from __future__ import annotations

import logging

from sqlalchemy import or_
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _fmt_time_12h(t) -> str:
    if not t:
        return ""
    h12 = t.hour % 12 or 12
    ampm = "AM" if t.hour < 12 else "PM"
    return f"{h12}:{t.minute:02d} {ampm}" if t.minute else f"{h12} {ampm}"


def _job_line(job) -> str:
    """"Tue, Aug 18 · 9 AM–12 PM · Maple Cottage" — no access details, ever."""
    parts = []
    if getattr(job, "scheduled_date", None):
        parts.append(job.scheduled_date.strftime("%a, %b %-d")
                     if hasattr(job.scheduled_date, "strftime") else str(job.scheduled_date))
    start = _fmt_time_12h(getattr(job, "start_time", None))
    end = _fmt_time_12h(getattr(job, "end_time", None))
    if start:
        parts.append(f"{start}–{end}" if end else start)
    prop = getattr(job, "property", None)
    where = (getattr(prop, "name", None) if prop is not None else None) or job.title or "New job"
    parts.append(where)
    return " · ".join(p for p in parts if p)


def notify_job_assigned(db: Session, job, cleaner_ids) -> int:
    """Push "New job for you" to each cleaner in `cleaner_ids` who has a linked
    login. Callers pass only the NEWLY-assigned IDs (create: all; update: the
    added set) so an unrelated edit never re-pings the whole crew. Best-effort:
    returns the number of successful sends, swallows everything."""
    ids = [str(c) for c in (cleaner_ids or []) if str(c).strip()]
    if not ids:
        return 0
    try:
        from database.models import User
        from services.push_service import notify_user, push_enabled

        if not push_enabled():
            return 0
        oid = getattr(job, "org_id", None)
        q = db.query(User).filter(User.cleaner_id.in_(ids), User.role == "cleaner")
        if oid is not None:
            # Same tenant guard as payroll's user map: cleaner_id isn't unique
            # across orgs, so never resolve another org's same-ID login.
            q = q.filter(or_(User.org_id == oid, User.org_id.is_(None)))
        sent = 0
        for u in q.all():
            sent += notify_user(
                u.id,
                "New job for you",
                _job_line(job),
                url="/my-day",
                tag=f"job-assign-{job.id}",
                category="job_assignments",
            )
        return sent
    except Exception:  # pragma: no cover - defensive: push must never break scheduling
        logger.exception("crew assignment push failed (job %s)", getattr(job, "id", "?"))
        return 0


def _offer_line(job) -> str:
    """"Sat, Sep 12 · 9 AM · Rockport, ME · $180" — town, never the house.

    Deliberately NOT `_job_line`. That one names the property, which is correct
    for somebody already assigned and wrong for an open offer: it is the one
    thing the board withholds until a job is won.
    """
    parts = []
    if getattr(job, "scheduled_date", None):
        parts.append(job.scheduled_date.strftime("%a, %b %-d")
                     if hasattr(job.scheduled_date, "strftime") else str(job.scheduled_date))
    start = _fmt_time_12h(getattr(job, "start_time", None))
    if start:
        parts.append(start)
    prop = getattr(job, "property", None)
    town = " ".join(x for x in [getattr(prop, "city", None),
                                getattr(prop, "state", None)] if x)
    if town:
        parts.append(town)
    rate = getattr(job, "posted_rate", None)
    if rate:
        parts.append(f"${rate:,.0f}" if float(rate).is_integer() else f"${rate:,.2f}")
    return " · ".join(parts) or "New work on the board"


def _cleared_recipients(db: Session, org_id) -> list:
    """Everyone whose file lets them actually take the work.

    Same answer the board and the claim endpoint use, via roster() — THREE
    queries for the whole bench rather than two per person, and one definition
    of "cleared" rather than a third one that could disagree with the other
    two. Pushing an offer to somebody who would be refused at claim time is a
    notification whose only possible outcome is a 403.
    """
    from services.sub_vetting import roster

    return [p for p in roster(db, org_id)["crew"]
            if p.get("can_work") and p.get("user_id")]


def notify_jobs_posted(db: Session, jobs, org_id=None) -> int:
    """Push "on the board" to every cleared sub. Best-effort, swallows all.

    CALLERS PASS ONLY NEWLY-POSTED JOBS. `turnover_windows.open_window` is
    idempotent and re-run by the daily tick, so a caller that passed everything
    currently open would text the whole bench the same Saturday every morning
    until somebody took it.

    A batch is ONE notification, not one per job: a twelve-house changeover day
    posting twelve times is how a person turns notifications off, and then they
    are off for the assignment that matters too.
    """
    jobs = [j for j in (jobs or []) if j is not None]
    if not jobs:
        return 0
    try:
        from services.push_service import notify_user, push_enabled

        if not push_enabled():
            return 0
        oid = org_id if org_id is not None else getattr(jobs[0], "org_id", None)
        people = _cleared_recipients(db, oid)
        if not people:
            return 0

        if len(jobs) == 1:
            job = jobs[0]
            title = "New job on the board"
            body = _offer_line(job)
            tag = f"job-open-{job.id}"
            # Somebody already on the job is not a bidder for it — the board
            # skips these rows for the same reason.
            on_it = {str(c) for c in (getattr(job, "cleaner_ids", None) or [])}
            people = [p for p in people if p.get("cleaner_id") not in on_it]
        else:
            title = f"{len(jobs)} jobs on the board"
            body = _batch_line(jobs)
            # One tag for the batch, so a re-post replaces rather than stacks.
            tag = f"jobs-open-{min(j.id for j in jobs)}-{len(jobs)}"

        sent = 0
        for p in people:
            sent += notify_user(p["user_id"], title, body, url="/my-day",
                                tag=tag, category="open_jobs")
        return sent
    except Exception:  # pragma: no cover - push must never break scheduling
        logger.warning("posted-job push failed", exc_info=True)
        return 0


def _batch_line(jobs) -> str:
    """"Sat, Sep 12 · Rockport, Camden · from $180"."""
    parts = []
    days = {j.scheduled_date for j in jobs if getattr(j, "scheduled_date", None)}
    if len(days) == 1:
        d = days.pop()
        parts.append(d.strftime("%a, %b %-d") if hasattr(d, "strftime") else str(d))
    towns = []
    for j in jobs:
        prop = getattr(j, "property", None)
        town = getattr(prop, "city", None) if prop is not None else None
        if town and town not in towns:
            towns.append(town)
    if towns:
        parts.append(", ".join(towns[:3]) + (" and more" if len(towns) > 3 else ""))
    rates = [float(j.posted_rate) for j in jobs if getattr(j, "posted_rate", None)]
    if rates:
        low = min(rates)
        money = f"${low:,.0f}" if low.is_integer() else f"${low:,.2f}"
        parts.append(money if len(set(rates)) == 1 else f"from {money}")
    return " · ".join(parts) or "New work on the board"
