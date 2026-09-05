"""Approving a claim without waiting for the office — and refusing to, mostly.

Routes took the recurring work off the approval queue (Phase 4). What's left is
one-off jobs, and most of those are the same answer every time: a vetted sub
asks for a posted job at the posted price, has no clash, and the office clicks
approve. Making a person click that is the office-is-the-bottleneck problem in
its smallest form — but it is also the last human check before somebody is
scheduled and money is committed, so this refuses far more often than it acts.

WHAT IT WILL AUTO-APPROVE, all of which must hold:
  * the rule is switched on (OFF by default — nothing here turns itself up);
  * the requester's vetting file is complete and current;
  * they asked at or below the posted rate. A counter-offer ABOVE the posted
    price is a negotiation, and a negotiation is not a formality;
  * the amount is at or under the ceiling the office set;
  * they are the ONLY pending request on the job. Where two people want the
    same work, picking a winner is a judgement about who — that is the
    office's to make, and doing it on arrival time would quietly turn the
    marketplace back into first-come-first-served;
  * approving raises no conflict — checked by the real approval path, not
    re-implemented here.

Approval itself goes through services/claim_approval.py, the same function the
office endpoint calls. There is one implementation of "approve a claim"; this
module only decides whether to call it.

Refusing is not an error and is never shown to the sub as a rejection. Their
request stands, pending, exactly as before — the office will get to it.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from database.models import JobClaimRequest

logger = logging.getLogger(__name__)

MODE_KEY = "claim_auto_approve_mode"          # off | auto
CEILING_KEY = "claim_auto_approve_max_rate"   # dollars; 0 or unset = no ceiling


def _mode(db: Session) -> str:
    from modules.settings.router import get_setting
    val = (get_setting(db, MODE_KEY) or "").strip().lower()
    return val if val in ("off", "auto") else "off"


def _ceiling(db: Session) -> Optional[float]:
    from modules.settings.router import get_setting
    raw = get_setting(db, CEILING_KEY)
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    return val if val > 0 else None


def why_not(db: Session, job, req: JobClaimRequest) -> Optional[str]:
    """Why this request shouldn't be auto-approved, or None if it can be.

    Returns a short machine-ish reason rather than a sentence: nothing here
    reaches a person. It is logged, so "over_ceiling" appearing constantly is
    the office finding out their ceiling is set too low.
    """
    if _mode(db) != "auto":
        return "rule_off"

    from database.models import User
    from services.sub_vetting import blocking_requirements
    requester = (db.query(User).filter(User.id == req.user_id).first()
                 if req.user_id else None)
    if requester is None or blocking_requirements(db, requester):
        # Belt and braces: the crew claim endpoint already refuses an
        # incomplete file. This is the gate that must not be reachable around,
        # so it is checked at the point of scheduling too.
        return "not_vetted"

    posted = job.posted_rate
    agreed = req.requested_rate if req.requested_rate is not None else posted
    if agreed is None:
        return "no_rate"
    if posted is not None and float(agreed) > float(posted):
        # Asking for more than the job was posted at is the sub opening a
        # negotiation. A negotiation gets a person.
        return "counter_above_posted"

    ceiling = _ceiling(db)
    if ceiling is not None and float(agreed) > ceiling:
        return "over_ceiling"

    rivals = (db.query(JobClaimRequest)
              .filter(JobClaimRequest.job_id == job.id,
                      JobClaimRequest.status == "pending",
                      JobClaimRequest.id != req.id)
              .count())
    if rivals:
        # Two people want it. Choosing between them on arrival time would
        # quietly restore first-come-first-served, which the marketplace pivot
        # replaced on purpose.
        return "competing_requests"
    return None


def consider(db: Session, job, req: JobClaimRequest, *, org_id: int) -> dict:
    """Auto-approve this request if every condition holds; otherwise leave it.

    Never raises into the caller. A request that stays pending is the normal,
    safe outcome and the crew endpoint's response is the same either way — the
    sub is told their request is in, and if it was taken instantly the job
    detail they land on says so.
    """
    reason = why_not(db, job, req)
    if reason:
        return {"auto_approved": False, "reason": reason}

    from modules.scheduling.router import _conflict_detail, _find_cleaner_conflicts
    from services.claim_approval import ClaimApprovalError, approve
    from utils.activity_logger import log_activity

    try:
        result = approve(db, job, req, org_id=org_id,
                         # No human decided this, so decided_by stays NULL
                         # rather than naming whoever happened to be logged in.
                         actor_user_id=None,
                         find_conflicts=_find_cleaner_conflicts,
                         conflict_detail=_conflict_detail,
                         log_activity=log_activity,
                         actor="system")
    except ClaimApprovalError as e:
        # A conflict or a closed job is a perfectly ordinary answer here: leave
        # the request pending and let the office look. Rolled back so a partial
        # write can't outlive the refusal.
        db.rollback()
        return {"auto_approved": False, "reason": e.code}
    except Exception as e:
        db.rollback()
        logger.error("[claim-auto-approve] failed on request %s: %s", req.id, e)
        return {"auto_approved": False, "reason": "error"}

    logger.info("[claim-auto-approve] job %s -> %s at %s",
                job.id, req.cleaner_id, result.get("agreed_rate"))
    return {"auto_approved": True, "agreed_rate": result.get("agreed_rate")}
