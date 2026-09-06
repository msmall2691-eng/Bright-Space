"""Approving a subcontractor's claim request — the one implementation.

This was the body of `approve_claim_request` in modules/scheduling/router.py.
It moved here for two reasons, and the second is the real one:

  1. Routers route (scheduling-invariants R6). This decides what somebody is
     paid and who is scheduled; it is not request parsing.
  2. Auto-approval (Phase 6) needs to approve a request too. A second
     implementation of "approve a claim" would be two places that assign a
     person, set agreed_rate, close the offer, decline the losers and seed the
     accepted response — and they would drift. The first thing to drift would
     be whichever one somebody forgot when adding a step, and the symptom
     would be money.

The router now parses and translates errors; the tick-side auto-approver calls
the same function with a different actor. Neither one re-implements anything.

CONCURRENCY (R5) stays with the CALLER, deliberately. Locking is about the
transaction the caller owns — `approve` operates on rows it was handed, and
handing it unlocked rows is the caller's bug to make. Both current callers take
the Job and the request FOR UPDATE first, and the docstring below says so
rather than pretending the lock lives here.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from database.models import JobClaimRequest
from database.models import JobResponse as JobResponseRow

logger = logging.getLogger(__name__)


class ClaimApprovalError(Exception):
    """Why a claim can't be approved, in a form a router can turn into a status.

    `code` is for the caller to branch on; `message` is what a person reads.
    Auto-approval reads the code (a conflict means "leave it for the office", a
    missing rate means "the office has to fix something") and never shows the
    message to a sub.
    """

    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def approve(db: Session, job, req: JobClaimRequest, *, org_id: int,
            actor_user_id: Optional[int], find_conflicts, conflict_detail,
            log_activity, actor: str = "staff") -> dict:
    """Give this job to this requester, at the rate that was agreed.

    The caller must already hold `job` and `req` FOR UPDATE — see the module
    docstring. Commits.

    `find_conflicts`, `conflict_detail` and `log_activity` are passed in rather
    than imported: they live in modules/scheduling/router.py, and importing that
    module here would make a service depend on a router (and, at import time,
    on the whole request stack the background tick has no business loading).
    """
    if req.status != "pending":
        raise ClaimApprovalError("not_pending", f"This request is already {req.status}.")
    if not job.open_for_claims:
        raise ClaimApprovalError("closed", "This job isn't open anymore.")

    # No rate on either side means nobody has agreed what this job pays, and
    # approving would schedule someone to work for an unstated amount. The crew
    # app refuses to file such a request, so reaching here means the office
    # cleared posted_rate after the request came in.
    agreed = req.requested_rate if req.requested_rate is not None else job.posted_rate
    if agreed is None:
        raise ClaimApprovalError(
            "no_rate",
            "No rate agreed: this job has no posted rate and the request didn't "
            "name one. Set a posted rate before approving.")

    # The other half of the same finding. Even with the posting guard, a job can
    # be posted, then assigned directly while a request is pending — and
    # approving would append the requester beside somebody who is already on it.
    # Refuse rather than silently make a two-person job out of a one-person
    # price. The office can unassign and approve, which is the same action said
    # out loud.
    others_on_it = [c for c in (job.cleaner_ids or [])
                    if str(c).strip() and str(c) != str(req.cleaner_id)]
    if others_on_it:
        raise ClaimApprovalError(
            "already_assigned",
            "Somebody is already assigned to this job. Take them off it first "
            "if you mean to give it to this person instead.")

    conflicts = find_conflicts(
        db, cleaner_ids=[req.cleaner_id], scheduled_date=job.scheduled_date,
        start_time=job.start_time, end_time=job.end_time, exclude_job_id=job.id,
        org_id=org_id,
    )
    if conflicts:
        raise ClaimApprovalError("conflict", conflict_detail(conflicts))

    now = datetime.now(timezone.utc)
    job.cleaner_ids = [*(c for c in (job.cleaner_ids or []) if c != req.cleaner_id),
                       req.cleaner_id]
    job.agreed_rate = agreed
    # WHO agreed it (migration 106). Without this the flat rate is paid to
    # anyone later added to cleaner_ids, and nothing can tell payroll that the
    # person who negotiated it has since been taken off the job.
    job.agreed_cleaner_id = req.cleaner_id
    job.open_for_claims = False
    req.status, req.decided_at, req.decided_by = "approved", now, actor_user_id

    # Asking for a job IS accepting it, so the office board must not show the
    # winner as "no answer yet" on work they went and asked for. Job detail
    # reads these rows and looked like the sub had gone quiet.
    #
    # Naive UTC to match every other write to this table — job_responses stores
    # naive datetimes, and an aware value here is naive on SQLite and aware on
    # Postgres, which is the timestamp hazard that bites arithmetic later.
    resp_now = now.replace(tzinfo=None)
    existing_resp = (db.query(JobResponseRow)
                     .filter(JobResponseRow.job_id == job.id,
                             JobResponseRow.cleaner_id == req.cleaner_id)
                     .first())
    if existing_resp:
        # A stale decline from a previous round on this job must not outlive
        # the sub asking for it again and winning.
        existing_resp.response, existing_resp.reason = "accepted", None
        existing_resp.updated_at = resp_now
    else:
        db.add(JobResponseRow(org_id=org_id, job_id=job.id, cleaner_id=req.cleaner_id,
                              user_id=req.user_id, response="accepted",
                              created_at=resp_now, updated_at=resp_now))

    others = (db.query(JobClaimRequest)
              .filter(JobClaimRequest.job_id == job.id,
                      JobClaimRequest.status == "pending",
                      JobClaimRequest.id != req.id)
              .all())
    for other in others:
        other.status, other.decided_at, other.decided_by = "declined", now, actor_user_id

    log_activity(
        db, "job_claim_approved", job_id=job.id, client_id=job.client_id, actor=actor,
        summary=f"Approved {req.cleaner_id}'s request at ${job.agreed_rate:,.2f}",
        extra_data={"cleaner_id": req.cleaner_id, "agreed_rate": job.agreed_rate,
                    "auto_declined": [o.id for o in others],
                    "auto_approved": actor == "system"},
        commit=False,
    )
    db.commit()

    notify(job, req, others)
    # The wire shape is exactly what the endpoint returned before this moved
    # into a service. A refactor is not the moment to change an API response;
    # the ids of the auto-declined requests are already in the activity log
    # above, which is where anything after the fact should read them.
    return {"status": "approved", "job_id": job.id, "cleaner_id": req.cleaner_id,
            "agreed_rate": job.agreed_rate}


def notify(job, req, others) -> None:
    """Tell the winner and the losers. Never allowed to fail the approval —
    the assignment is committed by the time this runs, and a push outage must
    not look like the job didn't happen."""
    try:
        from services.push_service import notify_user
        if req.user_id:
            notify_user(req.user_id, "You got the job!",
                        f"{job.title} on {job.scheduled_date} is yours "
                        f"at ${job.agreed_rate:,.2f}.",
                        url=f"/crew/jobs/{job.id}", category="crew")
        for other in others:
            if other.user_id:
                notify_user(other.user_id, "Job request declined",
                            f"Someone else got {job.title} on {job.scheduled_date}.",
                            url="/crew", category="crew")
    except Exception:
        pass


def agreed_with(job, cleaner_id) -> bool:
    """Is this the person who agreed the job's flat rate?

    THE BUG THIS REPLACES: three call sites asked `cid in job.cleaner_ids`,
    which is membership in the assignment list, not identity with the person
    who negotiated the number. Add a helper to a job agreed at $100 with sub A
    and both clock in — payroll paid A $100 and B $100. $200 out on a $100 job,
    every pay run, silently.

    Migration 106 put the answer on the row. The fallback covers rows written
    before it that the backfill could not resolve: exactly one cleaner on the
    job is unambiguous and is what payroll already paid them. Several cleaners
    and nobody named is the ambiguous case the column exists to end — nobody
    gets the flat rate (they fall through to the hourly ladder, which is
    recoverable) rather than everybody getting it (which is money out the
    door).

    THREE call sites, not two. The payroll summary and the Square export were
    fixed together in #774; services/sub_payouts.preview — the code that
    generates what a subcontractor is actually PAID — had the same
    `for cid in (j.cleaner_ids or [])` and was missed. Adding an hourly
    employee to a $100 marketplace job wrote them a $100 vendor payout row,
    which then feeds their 1099 year-to-date. Hence one function, here, rather
    than a fourth copy of the expression somewhere else later.
    """
    named = getattr(job, "agreed_cleaner_id", None)
    if named:
        return str(named) == str(cleaner_id)
    ids = [str(c) for c in (getattr(job, "cleaner_ids", None) or []) if str(c).strip()]
    return len(ids) == 1 and ids[0] == str(cleaner_id)


def release_if_displaced(db, job, *, notify=True) -> bool:
    """Clear the agreed rate when the sub who agreed it is no longer on the job.

    `agreed_rate` was written in two places and cleared nowhere, and it is not
    a field on JobUpdate, so no API path could unset it. The failure that
    produces:

      job agreed at $95 with sub A -> office reassigns the job -> A is silently
      off it, their claim request still reads "approved", nobody tells them —
      and hourly employee B is now the sole cleaner on a job still priced at a
      flat $95. Payroll pays B $95 instead of their hours.

    A stale rate also re-prices a job that gets re-opened later and awarded to
    nobody.

    So this runs at the cleaner_ids write sites, AFTER the write, and is a
    no-op unless the named cleaner has actually gone. Returns whether it
    changed anything. The caller commits — a helper that committed would
    decide the transaction boundary for a handler that owns it.
    """
    named = getattr(job, "agreed_cleaner_id", None)
    if not named or getattr(job, "agreed_rate", None) is None:
        return False
    if str(named) in {str(c) for c in (job.cleaner_ids or [])}:
        return False

    job.agreed_rate = None
    job.agreed_cleaner_id = None

    # The approved request outlived the arrangement it recorded. Reopening it
    # as pending would be worse — the office did not un-decide, they replaced
    # the person — so it is declined, with a reason, which is also the trail
    # somebody reads later when asking what happened to that job.
    now = datetime.now(timezone.utc)
    req = (db.query(JobClaimRequest)
           .filter(JobClaimRequest.job_id == job.id,
                   JobClaimRequest.cleaner_id == str(named),
                   JobClaimRequest.status == "approved")
           .first())
    if req is not None:
        # Declined, not reopened as pending: the office did not un-decide, they
        # replaced the person. There is no reason column on this table and
        # `message` is the SUB'S own words — overwriting it to explain
        # ourselves would delete what they wrote. The explanation goes to them
        # in the notification below.
        req.status, req.decided_at = "declined", now

    if notify:
        # Best-effort and last: a push must never be what decides whether the
        # money field got cleared.
        try:
            from database.models import User
            from services.push_service import notify_user

            u = (db.query(User)
                 .filter(User.cleaner_id == str(named), User.role == "cleaner")
                 .first())
            if u is not None:
                notify_user(u.id, "A job changed hands",
                            "The office has given a job you'd agreed to someone "
                            "else. Nothing else of yours is affected.",
                            url="/my-day", tag=f"job-released-{job.id}",
                            category="open_jobs")
        except Exception:
            logger.warning("release notification failed", exc_info=True)
    return True
