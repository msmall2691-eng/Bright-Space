"""Staffing a week of turnovers as one batch, and raising the price on what's left.

STR turnovers are not routes. They come from iCal feeds week to week and the
volume swings — twelve on a July Saturday, two in October — so nobody can own
them as a standing block. They stay posted jobs.

But posting them one at a time, each with its own approval, is the
office-is-the-bottleneck problem again on the busiest day of the week. A window
opens the whole service day at once and then does the part a person would
otherwise do badly at 9pm on Friday: it RAISES THE PRICE on whatever is still
unclaimed as the date closes in.

WHY THE LADDER IS THE POINT. A turnover nobody wants at $85 is a turnover
somebody wants at $110. Finding that out on Wednesday costs money; finding it
out on Friday night costs the booking. The ladder is the office deciding, once,
in advance, how much a Saturday is worth — instead of deciding it in a panic
per job.

WHAT THIS MODULE WILL NOT DO:
  * assign anybody. Opening a window sets `open_for_claims` and `posted_rate`;
    a sub still requests and the office still approves, exactly as in 097.
  * touch a job somebody has already taken. Every write here is filtered to
    unclaimed, unassigned work, and the step-up in particular must never
    reprice a job a person has already agreed to do.
  * delete or cancel anything (R7). A window that ends with work uncovered
    says so; it does not tidy the problem away.

Lives in a service so the tick and the router share one definition (R6) —
routers route, and a second copy of the ladder would drift.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Job, TurnoverWindow
from utils.dates import business_today

logger = logging.getLogger(__name__)

STATUSES = ("pending", "open", "closed")

# The job type a window staffs. Deliberately narrow: a window is about guest
# changeovers, and quietly opening a residential clean to the bench because it
# happened to fall on a Saturday would be a surprise.
WINDOW_JOB_TYPE = "str_turnover"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _scope(model, org_id: int):
    return or_(model.org_id == org_id, model.org_id.is_(None))


def window_jobs(db: Session, window: TurnoverWindow) -> list:
    """Every turnover on this window's service day, claimed or not."""
    return (db.query(Job)
            .filter(Job.job_type == WINDOW_JOB_TYPE,
                    Job.scheduled_date == window.service_date,
                    Job.status.notin_(["cancelled"]),
                    _scope(Job, window.org_id))
            .order_by(Job.start_time, Job.id)
            .all())


def _is_taken(job) -> bool:
    """Somebody has this one.

    Both halves matter. `cleaner_ids` covers an approved claim or an office
    assignment; `agreed_rate` covers the moment between approval and whatever
    else may follow. A job that is taken is never repriced and never reopened —
    that is the single rule the rest of this file is built to keep.
    """
    return bool(job.cleaner_ids) or bool(job.agreed_rate)


def current_rate(window: TurnoverWindow) -> Optional[float]:
    """What a turnover in this window is posted at right now.

    Each step adds `step_pct` of the BASE, never of the current price.
    Compounding a 10% ladder five times is a 61% raise, which is not what
    anybody typed into the box.
    """
    if window.base_rate is None:
        return None
    base = float(window.base_rate)
    steps = int(window.steps_taken or 0)
    return round(base * (1 + (float(window.step_pct or 0) / 100.0) * steps), 2)


def opens_on(window: TurnoverWindow) -> date:
    return window.service_date - timedelta(days=int(window.open_days_before or 0))


def first_step_on(window: TurnoverWindow) -> date:
    return window.service_date - timedelta(days=int(window.first_step_days_before or 0))


def open_window(db: Session, window: TurnoverWindow) -> dict:
    """Post this service day's turnovers to the bench.

    Only untaken jobs are touched. Re-running is safe and is expected — the
    daily tick calls this, and a window that opened yesterday should not
    re-post the three jobs that have since been claimed.
    """
    rate = current_rate(window)
    opened, skipped = [], 0
    for job in window_jobs(db, window):
        if _is_taken(job):
            skipped += 1
            continue
        job.open_for_claims = True
        if rate is not None:
            job.posted_rate = rate
        opened.append(job.id)
    if window.status != "open":
        window.status = "open"
        window.opened_at = _now()
    window.updated_at = _now()
    db.commit()
    return {"window_id": window.id, "opened": len(opened), "already_taken": skipped,
            "posted_rate": rate}


def step_window(db: Session, window: TurnoverWindow) -> dict:
    """Raise the price on what nobody has taken yet.

    Refuses past `max_steps` and refuses more than one step a day, so a tick
    that runs twice — a redeploy, a manual run — cannot climb the ladder twice
    in an afternoon. The cap is the office's stated ceiling on what a Saturday
    is worth; nothing here may exceed it.
    """
    if window.status != "open":
        return {"stepped": False, "reason": f"window is {window.status}"}
    if window.base_rate is None:
        return {"stepped": False, "reason": "no base rate to step from"}
    if int(window.steps_taken or 0) >= int(window.max_steps or 0):
        return {"stepped": False, "reason": "at the ceiling"}
    last = window.last_stepped_at
    if last is not None and last.date() >= business_today():
        return {"stepped": False, "reason": "already stepped today"}

    remaining = [j for j in window_jobs(db, window) if not _is_taken(j)]
    if not remaining:
        # Nothing left to sweeten. Not an error, and not a reason to close the
        # window either — a claim can still be withdrawn before Saturday.
        return {"stepped": False, "reason": "everything is taken"}

    window.steps_taken = int(window.steps_taken or 0) + 1
    window.last_stepped_at = _now()
    window.updated_at = _now()
    rate = current_rate(window)
    for job in remaining:
        job.posted_rate = rate
    db.commit()
    logger.info("[turnover-window] %s stepped to %s on %d unclaimed job(s)",
                window.service_date, rate, len(remaining))
    return {"stepped": True, "step": window.steps_taken, "posted_rate": rate,
            "jobs": len(remaining)}


def close_window(db: Session, window: TurnoverWindow) -> dict:
    """Stop the ladder. Leaves every job exactly as it is.

    Closing is a statement that the office has stopped bidding, not a cleanup:
    unclaimed turnovers stay open for claims at whatever they reached, because
    somebody taking one late is still better than nobody taking it (R7 — no
    automated path cancels work).
    """
    window.status = "closed"
    window.closed_at = _now()
    window.updated_at = _now()
    db.commit()
    return window_state(db, window)


def window_state(db: Session, window: TurnoverWindow) -> dict:
    """One window and how its day is actually going.

    `uncovered` is the number that matters and it is stated plainly rather than
    inferred from the others — an owner glancing at this wants to know whether
    Saturday is a problem, and any presentation that makes them do arithmetic
    to find out is the wrong one.
    """
    jobs = window_jobs(db, window)
    taken = [j for j in jobs if _is_taken(j)]
    open_now = [j for j in jobs if not _is_taken(j)]
    today = business_today()
    return {
        "id": window.id,
        "service_date": window.service_date.isoformat(),
        "status": window.status,
        "base_rate": round(float(window.base_rate), 2) if window.base_rate is not None else None,
        "current_rate": current_rate(window),
        "step_pct": window.step_pct,
        "steps_taken": window.steps_taken,
        "max_steps": window.max_steps,
        "at_ceiling": int(window.steps_taken or 0) >= int(window.max_steps or 0),
        "opens_on": opens_on(window).isoformat(),
        "first_step_on": first_step_on(window).isoformat(),
        "opened_at": window.opened_at.isoformat() if window.opened_at else None,
        "closed_at": window.closed_at.isoformat() if window.closed_at else None,
        "days_out": (window.service_date - today).days,
        "notes": window.notes,
        "total": len(jobs),
        "covered": len(taken),
        "uncovered": len(open_now),
        # What the day costs at today's price if everything still open is taken
        # at it. The number to look at before stepping again.
        "committed": round(sum(float(j.agreed_rate or 0.0) for j in taken), 2),
        "exposure": round(sum(float(j.posted_rate or 0.0) for j in open_now), 2),
        "jobs": [{
            "id": j.id,
            "title": j.title,
            "start_time": j.start_time.isoformat() if j.start_time else None,
            "property_id": j.property_id,
            "taken": _is_taken(j),
            "cleaner_ids": list(j.cleaner_ids or []),
            "posted_rate": j.posted_rate,
            "agreed_rate": j.agreed_rate,
            "open_for_claims": bool(j.open_for_claims),
        } for j in jobs],
    }


def due_to_open(db: Session, today: Optional[date] = None) -> list:
    """Pending windows whose opening day has arrived or passed.

    "Or passed" is deliberate: a deploy on the opening day, or a tick that
    didn't run, must not silently skip a window forever. The same reasoning
    that produced the recurring-generation starvation fix applies here.
    """
    today = today or business_today()
    rows = db.query(TurnoverWindow).filter(TurnoverWindow.status == "pending").all()
    return [w for w in rows if opens_on(w) <= today <= w.service_date]


def due_to_step(db: Session, today: Optional[date] = None) -> list:
    """Open windows whose ladder should climb today."""
    today = today or business_today()
    rows = db.query(TurnoverWindow).filter(TurnoverWindow.status == "open").all()
    out = []
    for w in rows:
        if w.base_rate is None or int(w.steps_taken or 0) >= int(w.max_steps or 0):
            continue
        if not (first_step_on(w) <= today <= w.service_date):
            continue
        if w.last_stepped_at is not None and w.last_stepped_at.date() >= today:
            continue
        out.append(w)
    return out


def run_due(db: Session) -> dict:
    """Open what's due and step what's due. The tick's whole job.

    Rides the existing turnover-coverage tick rather than adding a background
    job (R1). Daily granularity is the right shape anyway: a price ladder that
    moved hourly would be a negotiation nobody could follow.
    """
    opened, stepped = [], []
    for w in due_to_open(db):
        try:
            opened.append(open_window(db, w))
        except Exception as e:                       # one bad window must not
            db.rollback()                            # stop the others
            logger.error("[turnover-window] open failed for %s: %s", w.service_date, e)
    for w in due_to_step(db):
        try:
            r = step_window(db, w)
            if r.get("stepped"):
                stepped.append(r)
        except Exception as e:
            db.rollback()
            logger.error("[turnover-window] step failed for %s: %s", w.service_date, e)
    return {"opened": opened, "stepped": stepped}
