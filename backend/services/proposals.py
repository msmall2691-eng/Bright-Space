"""Autopilot approval gate — the ProposedAction service layer.

An AI tick or persona never mutates the schedule or messages a customer
directly. It records a ProposedAction (pending), a human approves or dismisses
it in the UI, and approval executes the action HERE through the exact write
path a human action takes:

  - assign_cleaner → modules.scheduling.router.update_job — the same function
    the dispatch board's drag-to-assign PATCH hits, so the conflict/
    availability/capacity guards and the Google Calendar sync side effects
    all come along (scheduling-invariants: Jobs stay the single canonical
    truth, one write path, no raw column writes).
  - send_sms → modules.comms.router.send_reply / send_sms_message — the same
    outbound path a human send uses, so the message is logged against the
    conversation like any other outbound.

Nothing in this module runs on a timer (R1): the EXISTING STR turnover
auto-assign tick calls propose_turnover_assignments() when its mode setting
is 'propose'. Deletion of canonical work is never proposed or executed (R7).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Client, Conversation, Job, ProposedAction, User

logger = logging.getLogger(__name__)

# Statuses are validated in code, deliberately not a DB enum type.
PROPOSAL_STATUSES = ("pending", "approved", "dismissed", "executed", "failed")

# The full set of kinds automation may propose. Executing anything else is
# refused at create time, so a bad payload can't smuggle in a new verb.
ALLOWED_KINDS = ("assign_cleaner", "send_sms")


def _utcnow():
    return datetime.now(timezone.utc)


def _validate_payload(kind: str, payload: dict) -> None:
    """Cheap shape check at create time so a proposal can't be approved into a
    guaranteed failure. Kind-specific; raises ValueError with a plain reason."""
    if kind == "assign_cleaner":
        # Matches what the existing assign path (update_job) expects:
        # Job.cleaner_ids holds crew-ID strings, so the payload carries the
        # crew-ID string, not a users.id.
        if not payload.get("job_id"):
            raise ValueError("assign_cleaner payload requires job_id")
        if not str(payload.get("cleaner_id") or "").strip():
            raise ValueError("assign_cleaner payload requires cleaner_id")
    elif kind == "send_sms":
        if not str(payload.get("body") or "").strip():
            raise ValueError("send_sms payload requires body")
        if not payload.get("conversation_id") and not payload.get("client_id"):
            raise ValueError("send_sms payload requires conversation_id or client_id")


def create_proposal(db: Session, org_id: int, agent_id: str, kind: str,
                    title: str, detail: str, payload: dict) -> ProposedAction:
    """Record a pending proposal. Validates `kind` against the allowlist and
    the payload's required fields.

    Dedupe guard: an identical PENDING proposal (same org, kind, payload)
    is returned instead of duplicated — this is what makes the propose-mode
    tick idempotent across runs."""
    if kind not in ALLOWED_KINDS:
        raise ValueError(f"Unknown proposal kind '{kind}'")
    payload = dict(payload or {})
    _validate_payload(kind, payload)

    # JSON-column equality is dialect-dependent (TEXT on SQLite, jsonb-ish on
    # Postgres), so compare in Python; the pending set per (org, kind) is small.
    for existing in db.query(ProposedAction).filter(
        ProposedAction.org_id == org_id,
        ProposedAction.kind == kind,
        ProposedAction.status == "pending",
    ).all():
        if (existing.payload or {}) == payload:
            return existing

    row = ProposedAction(
        org_id=org_id,
        agent_id=(agent_id or "")[:40] or None,
        kind=kind,
        title=(title or kind)[:255],
        detail=detail,
        payload=payload,
        status="pending",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _decided_by_id(user) -> int | None:
    """users.id for the decided_by FK. The master-API-key synthetic admin is
    id=0 (not a persisted row) — recording it would FK-violate on Postgres, so
    it maps to NULL (decision still timestamped, just not user-attributed)."""
    uid = getattr(user, "id", None)
    return uid if uid else None


def _claim_pending(db: Session, proposal: ProposedAction, new_status: str,
                   decided_by_user) -> None:
    """Atomically transition pending → new_status (compare-and-set on status),
    so two concurrent decisions can't both win. 409 when it isn't pending."""
    claimed = db.query(ProposedAction).filter(
        ProposedAction.id == proposal.id,
        ProposedAction.status == "pending",
    ).update({
        "status": new_status,
        "decided_at": _utcnow(),
        "decided_by": _decided_by_id(decided_by_user),
    }, synchronize_session=False)
    if not claimed:
        db.rollback()
        raise HTTPException(status_code=409,
                            detail=f"Proposal is not pending (status: {proposal.status})")
    db.commit()
    db.refresh(proposal)


def dismiss_proposal(db: Session, proposal: ProposedAction,
                     decided_by_user) -> ProposedAction:
    """pending → dismissed, recording who decided. 409 when not pending."""
    _claim_pending(db, proposal, "dismissed", decided_by_user)
    return proposal


def execute_proposal(db: Session, proposal: ProposedAction,
                     decided_by_user) -> ProposedAction:
    """Approve + execute in one request: pending → approved (atomic, 409 if
    not pending, committed before executing so the decision survives any
    execution failure), then kind-dispatched through the existing human write
    path. Success → 'executed' with a result; any exception → 'failed' with
    {'error': ...} — never a 500 that loses the state transition."""
    _claim_pending(db, proposal, "approved", decided_by_user)

    payload = dict(proposal.payload or {})
    try:
        if proposal.kind == "assign_cleaner":
            result = _execute_assign_cleaner(db, proposal.org_id, payload)
        elif proposal.kind == "send_sms":
            result = _execute_send_sms(db, proposal.org_id, payload,
                                       author=proposal.agent_id)
        else:  # pragma: no cover — create_proposal enforces the allowlist
            raise ValueError(f"Unknown proposal kind '{proposal.kind}'")
    except Exception as e:
        # Roll back any partial execution writes; the approved transition was
        # already committed, so the proposal row (and the decision) survive.
        db.rollback()
        detail = e.detail if isinstance(e, HTTPException) else str(e)
        logger.warning("[proposals] execution failed for proposal %s (%s): %s",
                       proposal.id, proposal.kind, detail)
        row = db.query(ProposedAction).filter(
            ProposedAction.id == proposal.id).first() or proposal
        row.status = "failed"
        row.result = {"error": str(detail)}
        db.commit()
        db.refresh(row)
        return row

    proposal.status = "executed"
    proposal.result = result
    db.commit()
    db.refresh(proposal)
    return proposal


def _execute_assign_cleaner(db: Session, org_id: int, payload: dict) -> dict:
    """Assign via the EXISTING write path: scheduling's update_job — the exact
    function behind the dispatch board's drag-to-assign PATCH. Its conflict/
    availability/capacity guards and Google Calendar sync ride along; raw
    Job.cleaner_ids writes are exactly what this module exists to avoid."""
    # Lazy import via the module object (not `from ... import update_job`) so
    # tests can monkeypatch the router attribute, and to dodge import cycles.
    from modules.scheduling import router as scheduling_router

    job_id = int(payload["job_id"])
    cleaner_id = str(payload["cleaner_id"]).strip()
    job_dict = scheduling_router.update_job(
        job_id,
        scheduling_router.JobUpdate(cleaner_ids=[cleaner_id]),
        db=db,
        org_id=org_id,
    )
    return {
        "job_id": job_id,
        "cleaner_ids": (job_dict or {}).get("cleaner_ids") or [cleaner_id],
        "assigned": cleaner_id,
    }


def _execute_send_sms(db: Session, org_id: int, payload: dict,
                      author: str | None = None) -> dict:
    """Send via the EXISTING outbound comms path, org-scoped, so the message
    lands on the conversation exactly like a human send (logged, previews,
    unread bookkeeping)."""
    from modules.comms import router as comms_router

    body = str(payload["body"])
    conv_id = payload.get("conversation_id")
    if conv_id:
        # Org-scope the fetch ourselves (send_reply trusts its caller): the
        # standard or_-NULL tenant filter, pre-tenancy rows belong to org 1.
        conv = db.query(Conversation).filter(
            Conversation.id == int(conv_id),
            or_(Conversation.org_id == org_id, Conversation.org_id.is_(None)),
        ).first()
        if not conv:
            raise ValueError(f"Conversation {conv_id} not found in this workspace")
        msg = comms_router.send_reply(
            conv.id, comms_router.SendReplyRequest(body=body, author=author), db=db)
        return {"conversation_id": conv.id, "message_id": (msg or {}).get("id"),
                "status": (msg or {}).get("status")}

    client_id = int(payload["client_id"])
    client = db.query(Client).filter(
        Client.id == client_id,
        or_(Client.org_id == org_id, Client.org_id.is_(None)),
    ).first()
    if not client:
        raise ValueError(f"Client {client_id} not found in this workspace")
    if not (client.phone or "").strip():
        raise ValueError(f"Client {client_id} has no phone number on file")
    msg = comms_router.send_sms_message(
        comms_router.SMSRequest(to=client.phone, body=body, client_id=client.id),
        db=db)
    return {"client_id": client.id,
            "conversation_id": (msg or {}).get("conversation_id"),
            "message_id": (msg or {}).get("id"),
            "status": (msg or {}).get("status")}


def propose_turnover_assignments(db: Session, picks: list[dict],
                                 agent_id: str = "mia") -> dict:
    """Turn the auto-assign tick's dry-run picks into pending proposals.

    Called by the EXISTING str_turnover_autoassign_tick when
    str_auto_assign_mode = 'propose' (R1: no new tick). Each pick is one
    {job_id, cleaner_id, title, date} row from
    auto_assign_unassigned_turnovers(dry_run=True). Idempotent across tick
    runs via create_proposal's dedupe guard (identical pending payloads are
    not duplicated)."""
    from modules.auth.router import _default_org_id

    created, existing = [], []
    for pick in picks:
        job = db.query(Job).filter(Job.id == pick["job_id"]).first()
        if job is None:
            continue
        org_id = job.org_id or _default_org_id(db)
        cleaner_id = str(pick["cleaner_id"])
        cleaner = db.query(User).filter(User.cleaner_id == cleaner_id).first()
        cleaner_name = (cleaner.full_name or cleaner.email) if cleaner else f"cleaner {cleaner_id}"
        prop = getattr(job, "property", None)
        where = (prop.name if prop and prop.name else None) or job.title or f"job {job.id}"
        when = pick.get("date") or (str(job.scheduled_date) if job.scheduled_date else "unscheduled")
        title = f"Assign {cleaner_name} to {where} turnover on {when}"
        detail = (f"STR turnover auto-assign (propose mode) picked {cleaner_name} "
                  f"for '{job.title}' on {when}. Approving assigns through the "
                  f"normal schedule write path; dismissing leaves the job unassigned.")
        before = db.query(ProposedAction.id).count()
        row = create_proposal(
            db, org_id=org_id, agent_id=agent_id, kind="assign_cleaner",
            title=title, detail=detail,
            payload={"job_id": job.id, "cleaner_id": cleaner_id},
        )
        after = db.query(ProposedAction.id).count()
        (created if after > before else existing).append(row.id)
    return {"proposed": created, "already_pending": existing}
