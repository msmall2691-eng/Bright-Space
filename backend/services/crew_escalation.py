"""Standing rule — a job nobody is on gets offered to the crew.

The gap this closes: today an unassigned job coming up produces a number on
the board and, for STR turnovers, an ERROR line in the server log. Neither
does anything. The office already has a one-click "Open to crew" that puts a
job on the crew's open-jobs board for someone to claim — it just has to be
remembered and pressed, job by job, by the one person who is also doing
everything else.

So: as a job's date closes in with nobody on it, either park an `open_to_crew`
proposal for approval ('propose', the default) or open it directly ('auto').

WHY OPENING IS THE SAFE ESCALATION: it is additive and reversible. It does not
assign anyone, does not move or edit the job, and does not text a customer —
it makes the job visible to the crew. Access details stay hidden on an open
listing until it's claimed (BB-SEC-11/12, enforced in modules/crew/router.py,
not here). Closing it again is one flag away.

NO NEW TICK (economy rule 1 / R1): this rides `schedule_audit_tick`, the
existing every-six-hours read-only schedule housekeeping pass. Six hours is the
right grain for a rule measured in days, and the tick already exists to notice
things about the schedule that nobody has got to yet.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from utils.dates import business_date

from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from database.models import Job, ProposedAction
from services.proposals import create_proposal

logger = logging.getLogger(__name__)

AGENT_ID = "mia"          # Operations — scheduling, dispatch, crew coordination

# Never open more than this in one pass. A backlog import or a week nobody
# staffed shouldn't dump forty jobs onto the crew board (or forty rows onto
# Home) in a single tick.
_MAX_PER_RUN = 10


def _horizon(now: datetime, hours: int) -> tuple:
    """The window: from today up to `hours` out.

    Deliberately inclusive of today rather than starting at `now` — a job at
    2pm today with nobody on it is the most urgent case there is, and excluding
    the current day to avoid a partial-day edge would skip exactly that one.
    Jobs are dated (and timed) separately, so this filters on the date and lets
    the day boundary be generous."""
    # Both ends business-local: Job.scheduled_date is a business-local Date,
    # and the UTC date is already tomorrow from 8pm here. That slid the window
    # a day out AND dropped today — the one case the docstring above says this
    # is deliberately inclusive of.
    return business_date(now), business_date(now + timedelta(hours=hours))


def find_uncovered(db: Session, *, hours: int, now: datetime | None = None,
                   org_id: int | None = None) -> list[Job]:
    """Scheduled jobs inside the window with nobody assigned and not already
    open to the crew.

    `cleaner_ids` is a JSON list column, so "is it empty" can't be a reliable
    SQL predicate across SQLite and Postgres — the date/status/flag filters run
    in SQL and the emptiness check runs in Python over what's left, which for a
    window measured in days is a handful of rows."""
    now = now or datetime.now(timezone.utc)
    start, end = _horizon(now, hours)
    q = (db.query(Job).options(joinedload(Job.client), joinedload(Job.property))
         .filter(Job.status == "scheduled",
                 Job.scheduled_date >= start,
                 Job.scheduled_date <= end,
                 or_(Job.open_for_claims.is_(None),
                     Job.open_for_claims == False)))  # noqa: E712
    if org_id is not None:
        q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))
    rows = q.order_by(Job.scheduled_date.asc()).limit(200).all()
    return [j for j in rows if not (j.cleaner_ids or [])]


def _where(job: Job) -> str:
    prop = getattr(job, "property", None)
    if prop is not None and (prop.name or "").strip():
        return prop.name
    client = getattr(job, "client", None)
    if client is not None and (client.name or "").strip():
        return client.name
    return job.title or f"job {job.id}"


def _proposal_detail(job, when: str) -> str:
    """What the office reads before approving "offer this to the bench".

    Says the PRICE STATE, which it did not (review finding 15). This rule opens
    work with whatever `posted_rate` the job happens to carry, and most
    uncovered jobs carry none — so approving the card put a job on the board
    that can only be worked at a price the sub names. That is opening a
    negotiation, and it is a different decision from offering known work at a
    known price. The office should be making it on purpose.
    """
    rate = getattr(job, "posted_rate", None)
    price = (f"It goes up at ${rate:,.2f}." if rate is not None else
             "IT GOES UP WITH NO ASKING PRICE — whoever wants it has to name "
             "their own, so approving this opens a negotiation rather than "
             "offering a set rate. Put a rate on the job first if you'd "
             "rather not.")
    return (f"'{job.title or 'This job'}' is scheduled for {when} and still has "
            f"nobody on it. Opening it puts the job on the bench's board, where "
            f"a subcontractor can ASK for it — nothing is assigned until you "
            f"approve somebody, and the house's access details stay hidden "
            f"until then. {price}")


def escalate_uncovered_jobs(db: Session, *, mode: str, hours: int,
                            now: datetime | None = None) -> dict:
    """Run the rule. 'off' does nothing; 'propose' queues; 'auto' opens.

    Returns {mode, considered, proposed[], opened[], skipped{}}. One bad job
    never costs the rest — an unopenable job is counted and stepped over."""
    if mode not in ("propose", "auto"):
        return {"mode": mode or "off", "skipped": {"disabled": 1},
                "considered": 0, "proposed": [], "opened": []}

    now = now or datetime.now(timezone.utc)
    jobs = find_uncovered(db, hours=hours, now=now)
    proposed, opened = [], []
    skipped: dict[str, int] = {}

    # create_proposal de-duplicates an identical pending payload by RETURNING
    # the existing row, so its return value alone can't tell "queued this" from
    # "this was already queued". Without this set the tick would report ten new
    # proposals every six hours forever, for the same ten untouched jobs.
    already = {p.id for p in db.query(ProposedAction.id).filter(
        ProposedAction.kind == "open_to_crew",
        ProposedAction.status == "pending").all()}

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    for job in jobs:
        # Counts only what this pass actually did, so a standing backlog of
        # pending proposals can't starve the cap and hide a newly-uncovered job.
        if len(proposed) + len(opened) >= _MAX_PER_RUN:
            skip("over_limit")
            continue
        org_id = job.org_id
        if not org_id:
            # Pre-tenancy rows belong to the founding org; resolve rather than
            # guess, so a proposal can't be written into the wrong workspace.
            from modules.auth.router import _default_org_id
            org_id = _default_org_id(db)

        when = str(job.scheduled_date) if job.scheduled_date else "an upcoming date"
        title = f"Offer {_where(job)} on {when} to the crew"
        detail = _proposal_detail(job, when)
        try:
            if mode == "auto":
                _open_now(db, org_id, job.id)
                opened.append(job.id)
            else:
                row = create_proposal(
                    db, org_id=org_id, agent_id=AGENT_ID, kind="open_to_crew",
                    title=title, detail=detail, payload={"job_id": job.id})
                if row.id in already:
                    skip("already_proposed")
                else:
                    proposed.append(row.id)
        except Exception:
            logger.exception("[crew-escalation] could not escalate job %s", job.id)
            skip("failed")

    if proposed or opened:
        logger.info("[crew-escalation] mode=%s proposed=%s opened=%s skipped=%s",
                    mode, len(proposed), len(opened), skipped)
    return {"mode": mode, "considered": len(jobs), "proposed": proposed,
            "opened": opened, "skipped": skipped}


def _open_now(db: Session, org_id: int, job_id: int) -> None:
    """'auto' mode goes through the SAME executor an approved proposal uses, so
    there is one implementation of "open this job" and both modes carry the
    real write path's guards (scheduling-invariants R6)."""
    from services.proposals import _execute_open_to_crew

    _execute_open_to_crew(db, org_id, {"job_id": job_id})
