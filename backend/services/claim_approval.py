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

from sqlalchemy import or_
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
    # THE FLAG IS NOT THE JOB. Approval checked `open_for_claims` and never
    # `status`, and nothing wrote the flag False on cancel — so approving a
    # cancelled job scheduled the sub onto it, fixed a rate, and pushed them
    # "You got the job!" for work that no longer existed.
    #
    # `close_offer` below now closes the offer at every cancel path we own, so
    # this should be unreachable through them. It is here for the paths we do
    # not: a row cancelled by an older release, a bulk update, an endpoint
    # somebody adds next year. Scheduling somebody onto dead work is the kind
    # of mistake that must fail at the last gate too, not only the first.
    if job.status != "scheduled":
        raise ClaimApprovalError(
            "not_scheduled",
            f"This job is {job.status} — it can't be given to anyone."
            if job.status != "cancelled" else
            "This job was cancelled. Re-open it on the schedule first if it's "
            "back on.")

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
    not look like the job didn't happen.

    TWO THINGS WERE WRONG HERE (review findings 13 and 14).

    CATEGORY. Both messages went out under `category="crew"`, which is an
    OFFICE category (`push_service.OFFICE_NOTIFICATION_CATEGORIES`). A
    subcontractor's notification settings offer job_assignments, open_jobs,
    office_messages, time_off and digest — so the two messages that matter
    most to them answered to none of their toggles. Winning work is
    `job_assignments`; losing an offer is `open_jobs`, which is the
    offered-versus-given distinction those categories exist to keep.

    ONE TRY BLOCK. The winner and every loser shared a single try/except
    ending in a bare `pass`. A push that raised for the winner — a dead
    subscription row, a malformed endpoint — meant the loop telling everyone
    else never ran, and nothing was logged to say why they heard nothing. Each
    recipient now stands alone and a failure is written down.
    """
    from services import push_service

    def _tell(user_id, title, body, *, url, category):
        if not user_id:
            return
        try:
            push_service.notify_user(user_id, title, body, url=url, category=category)
        except Exception:
            # Per recipient, deliberately: one unreachable phone is one person
            # who missed a message, not everybody.
            logger.warning("claim notification failed for user %s on job %s",
                           user_id, getattr(job, "id", "?"), exc_info=True)

    _tell(req.user_id, "You got the job!",
          f"{job.title} on {job.scheduled_date} is yours "
          f"at ${job.agreed_rate:,.2f}.",
          url=f"/crew/jobs/{job.id}", category="job_assignments")
    for other in others:
        _tell(other.user_id, "Job request declined",
              f"Someone else got {job.title} on {job.scheduled_date}.",
              url="/crew", category="open_jobs")


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


def close_offer(db, job, *, reason: str, notify: bool = True) -> int:
    """Take a job off the board and answer everyone still waiting on it.

    THE OFFER AND ITS PENDING REQUESTS LIVE AND DIE TOGETHER. That was true in
    intent and nowhere in code: `open_for_claims` was written True by the
    posting paths and False by exactly one thing — a successful approval.
    Cancel a posted job and it stayed posted. The crew board lists only jobs
    that are open AND `scheduled`, so the request went invisible in the sub's
    app while staying `pending` in the database, forever: never answered, still
    counting against them on the bench roster ("holding 3"), and — because
    `approve` checked the flag and not the status — still approvable, which
    pushed somebody "You got the job!" for a job that no longer existed.

    `withdrawn`, not `declined`. The sub was not turned down; the work was
    taken off the table. Telling somebody they were declined for a cancelled
    job says they lost a competition that never happened. This is also the
    first code to write that status, which the office UI has rendered since the
    marketplace pivot and nothing produced.

    Idempotent, and returns how many people it answered. The caller commits —
    same reasoning as `release_if_displaced`: a helper that committed would
    decide the transaction boundary for a handler that owns it.

    `reason` is the phrase the sub reads ("was cancelled", "is no longer
    available"), so it must complete "The job you asked for ...".
    """
    if getattr(job, "open_for_claims", False):
        job.open_for_claims = False

    # FOR UPDATE (scheduling-invariants R5). The write paths that call this
    # already hold the Job; the unattended sweep holds nothing, and without the
    # lock it could read a row as pending, have an approval commit underneath
    # it, and then stamp `withdrawn` over `approved` — a request marked
    # withdrawn on a job the person is actually scheduled for. Narrow window,
    # cheap to close, and the office would never work out what happened.
    # SQLite ignores FOR UPDATE (it serializes writers anyway).
    pending = (db.query(JobClaimRequest)
               .filter(JobClaimRequest.job_id == job.id,
                       JobClaimRequest.status == "pending")
               .with_for_update()
               .all())
    if not pending:
        return 0

    now = datetime.now(timezone.utc)
    for req in pending:
        # No `decided_by`: nobody decided about this person. The office
        # withdrew the work, and attributing that to whoever happened to be
        # logged in would read, later, as "Meg declined Dan".
        req.status, req.decided_at = "withdrawn", now

    if notify:
        # Best-effort and last: a push outage must never be what decides
        # whether the job came off the board.
        try:
            from services.push_service import notify_user
            when = f" on {job.scheduled_date}" if job.scheduled_date else ""
            for req in pending:
                if req.user_id:
                    notify_user(req.user_id, "That job is off the board",
                                f"{job.title}{when} {reason}. Your request is "
                                f"closed — nothing else of yours is affected.",
                                url="/my-day", tag=f"offer-closed-{job.id}",
                                category="open_jobs")
        except Exception:
            logger.warning("offer-closed notification failed", exc_info=True)
    return len(pending)


def sweep_dead_offers(db, *, limit: int = 500) -> int:
    """Close offers that outlived their job, quietly. Returns how many.

    `close_offer` runs at the paths that CHANGE a job — cancel, skip, un-post,
    delete. Two kinds of dead offer never go through one of those:

      * the day came and went. A job posted for Saturday and never approved is
        still flagged open on Sunday, and the requests on it are still pending
        — for work that cannot now be done. Nothing edits the row, so nothing
        was ever going to notice.
      * a job cancelled by a release that predates this fix, and not touched
        since. Those rows exist in production right now; this heals them
        without a migration, which is the honest way to fix data that a bug
        wrote rather than pretending the code change alone is the whole fix.

    SILENT, deliberately — `notify=False`. The other paths tell people because
    something just changed under them. Here nothing did: the day passed, or the
    cancellation they were already told about is being tidied up. Pushing "that
    job is off the board" for a job from three weeks ago is a notification with
    no possible action, and on the first pass over the backlog it would be
    dozens of them at once.

    Rides the existing schedule-audit tick (scheduling-invariants R1: a task on
    an existing tick, not a new one). Capped per pass so a large backlog is
    worked down over a few hours instead of in one long transaction.

    Not org-scoped, like every other tick-side pass: this runs with no request
    and no `app.current_org_id` GUC, so there is no tenant to scope TO. It is
    safe because it never crosses records — each job's own requests, decided
    by that job's own state — and an offer whose day has gone is dead in every
    org there is.
    """
    from database.models import Job
    from utils.dates import business_today

    today = business_today()
    dead = (db.query(Job)
            .filter(Job.open_for_claims.is_(True))
            .filter(or_(Job.scheduled_date < today,
                        Job.scheduled_date.is_(None),
                        Job.status != "scheduled"))
            .limit(limit)
            .all())
    closed = 0
    for job in dead:
        close_offer(db, job, reason="is no longer available", notify=False)
        closed += 1
    if closed:
        db.commit()
    return closed
