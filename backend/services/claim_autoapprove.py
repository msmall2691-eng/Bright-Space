"""Claiming a posted job instantly — the Turno-style marketplace — and the
one case that still waits for the office.

THE MODEL, chosen by the owner in writing (Sept 2026), replacing the earlier
"the office picks who gets it" queue. A cleared sub who claims a posted job at
(or below) the posted price gets it THE MOMENT THEY CLAIM — it is theirs, the
offer closes, and nobody has to approve anything. This is legal because it is
the sub ACCEPTING the office's offer at the office's price; Rule 0 forbids the
office ASSIGNING, not the sub accepting (brightbase-marketplace). First to
claim wins — the marketplace is a real marketplace now.

WHAT IS INSTANT, all of which must hold:
  * instant claiming is on. It is OFF by default and the switch FAILS CLOSED:
    the office turns it on explicitly (standing rules) once its bench is vetted.
    Switched off in writing (Sept 2026) — see `_instant_on` for why the missing
    human-approval step made a grandfathered bench unsafe to auto-award to;
  * the requester's vetting file is complete and current. THIS IS THE ONE
    NON-NEGOTIABLE — an uninsured person in a customer's house is the risk the
    whole vetting gate exists for, and it is checked here too, not just at the
    /ask endpoint;
  * the job carries a posted price. An unpriced job has no anchor to be "at or
    below", so naming a price on one is a negotiation the office runs;
  * they claimed at or below that posted price. A bid ABOVE the posted price is
    the sub asking the office to pay MORE — the one thing that still comes to a
    person, because it is the office agreeing to a number it did not set.

FIRST COME, FIRST SERVED, and it is safe without picking a winner here. The
first claim runs approve(), which closes the offer (open_for_claims = False);
the /ask endpoint refuses a claim on a closed offer, so the second claimant
gets "isn't open anymore" at the door. The FOR UPDATE lock in consider() covers
the narrow simultaneous case: two claims in flight at once serialize, the first
commits and closes, the second wakes under the lock and approve() refuses the
closed job. So there is deliberately NO rival-count check — that check WAS the
"office picks" design, and it is what the owner replaced.

Approval itself goes through services/claim_approval.py, the same function the
office endpoint calls. There is one implementation of "approve a claim"; this
module only decides whether to call it. A request that is NOT instant (a bid
above posted, an unpriced job, instant turned off) stays pending exactly as
before and the office gets to it — never shown to the sub as a rejection.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from database.models import JobClaimRequest

logger = logging.getLogger(__name__)

# off | auto. The setting key the standing rule writes. The DEFAULT is OFF and
# the gate FAILS CLOSED: instant claiming is live ONLY when the office has
# explicitly set it to "auto". This was switched off in writing (Sept 2026)
# because the compensating control instant claim removed — a human approving
# each claim, and in doing so looking at the requester's file — is what made a
# grandfathered bench safe. `services/sub_vetting.blocking_requirements` returns
# nothing for every account that predates `crew_vetting_enforce_from`, so with
# no human in the loop an out-of-date file (lapsed COI, unsigned agreement)
# would sail through. Instant claim can go back on once the bench's documents
# are actually in and that cutoff can be cleared — at which point the vetting
# gate below becomes true again and the feature is safe on its own terms.
MODE_KEY = "claim_auto_approve_mode"


def _instant_on(db: Session) -> bool:
    from modules.settings.router import get_setting
    val = (get_setting(db, MODE_KEY) or "").strip().lower()
    # FAIL CLOSED: on only for the explicit "auto". Unset, "off", or any stray
    # or corrupted value ("false", "0", "disabled", "") reads as OFF, so the
    # office can never be instant-claiming a job without having chosen to.
    return val == "auto"


def instant_claims_on(db: Session) -> bool:
    """Public read of the same decision `consider()` makes: is instant claiming
    switched on right now? The crew board asks this so its copy tells the truth —
    "claim it and it's yours" only when a claim really will be instant, not a
    promise that resolves to a pending request when the office has it off."""
    return _instant_on(db)


def why_not(db: Session, job, req: JobClaimRequest) -> Optional[str]:
    """Why this claim shouldn't be awarded instantly, or None if it can be.

    Returns a short machine-ish reason rather than a sentence: nothing here
    reaches a person. It is logged, so "counter_above_posted" appearing on a
    job is simply the trail of a bid the office was handed to decide.
    """
    if not _instant_on(db):
        return "instant_off"

    from database.models import User
    from services.sub_vetting import blocking_requirements
    requester = (db.query(User).filter(User.id == req.user_id).first()
                 if req.user_id else None)
    if requester is None or blocking_requirements(db, requester):
        # THE ONE NON-NEGOTIABLE. The /ask endpoint already refuses an
        # incomplete file; this is the gate that must not be reachable around,
        # so a claim is re-checked against it at the moment it would be awarded.
        return "not_vetted"

    posted = job.posted_rate
    if posted is None:
        # No posted price is no anchor — naming a number on an unpriced job is
        # a negotiation the office runs, never an instant claim.
        return "no_posted_rate"
    agreed = req.requested_rate if req.requested_rate is not None else posted
    if float(agreed) > float(posted):
        # A bid ABOVE the posted price is the sub asking to be paid more than
        # the office offered. That is the office's yes to give, not this code's.
        return "counter_above_posted"
    # Cleared, priced, at or below posted: theirs, now. First to claim wins;
    # the offer-close + lock (see the module docstring) make that safe without
    # choosing between rivals here.
    return None


def consider(db: Session, job, req: JobClaimRequest, *, org_id: int) -> dict:
    """Award this claim instantly if every condition holds; otherwise leave it.

    Never raises into the caller. A claim that is NOT instant (a bid above
    posted, an unpriced job, instant off) stays pending — the normal, safe
    outcome — and the crew endpoint's response is the same either way: the sub
    is told their claim is in, and if it was theirs instantly the job detail
    they land on says so.
    """
    # CONCURRENCY (scheduling-invariants R5). approve()'s contract is that the
    # caller holds `job` and `req` FOR UPDATE. The /ask handler loads the job
    # unlocked and commits the request, then hands both here; two subs claiming
    # the same job at the same instant could otherwise both reach approve() —
    # two subs on a one-person job, both told "it's yours".
    #
    # Re-reading both rows FOR UPDATE serializes the whole decide-and-award per
    # job: the open/scheduled checks and the write happen under the lock, so the
    # second caller blocks until the first commits, then wakes to a closed offer
    # (approve() sets open_for_claims = False) and refuses. That is what makes
    # first-come-first-served safe without choosing a winner here. Same
    # identity-map objects the caller passed, now locked; on Postgres this is
    # SELECT ... FOR UPDATE, SQLite serializes writers.
    from database.models import Job
    job = db.query(Job).filter(Job.id == job.id).with_for_update().first()
    req = (db.query(JobClaimRequest)
           .filter(JobClaimRequest.id == req.id).with_for_update().first())
    if job is None or req is None:
        return {"auto_approved": False, "reason": "gone"}

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
