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
ALLOWED_KINDS = ("assign_cleaner", "send_sms", "create_job_from_gcal",
                 "open_to_crew")


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
    elif kind == "open_to_crew":
        # Additive and reversible: it puts the job on the crew's open-jobs
        # board. Nothing else is needed — who claims it is the crew's move.
        if not payload.get("job_id"):
            raise ValueError("open_to_crew payload requires job_id")
    elif kind == "create_job_from_gcal":
        # Everything _execute_create_job_from_gcal needs to build a JobCreate
        # and call scheduling's create_job — there's no separate staging row
        # holding the raw event, so the payload IS the record. gcal_event_id
        # is required even though JobCreate doesn't otherwise need one: it's
        # what stamps the new Job so the next sync_calendar() poll finds it
        # via the existing gcal_event_id lookup and takes the already-linked
        # branch instead of re-proposing (see gcal_sync.py).
        required = ("client_id", "title", "scheduled_date", "start_time",
                    "end_time", "gcal_event_id")
        missing = [f for f in required if not payload.get(f)]
        if missing:
            raise ValueError(
                f"create_job_from_gcal payload requires {', '.join(missing)}")


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
        elif proposal.kind == "open_to_crew":
            result = _execute_open_to_crew(db, proposal.org_id, payload)
        elif proposal.kind == "create_job_from_gcal":
            result = _execute_create_job_from_gcal(db, proposal.org_id, payload)
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


def _execute_open_to_crew(db: Session, org_id: int, payload: dict) -> dict:
    """Put the job on the crew's open-jobs board via the EXISTING write path:
    scheduling's update_job, the same function behind the office's one-click
    "Open to crew". `open_for_claims` is a real field on JobUpdate, so this is
    the identical write a human makes — no raw column poke.

    Opening does NOT assign anyone. A subcontractor ASKS for the job (several
    may be waiting at once) and the OFFICE approving one of them is what closes
    the offer and reveals the access details (BB-SEC-11/12) — not the first tap,
    which is what this said before the marketplace pivot. A rule that can only
    open an offer, never hand one out, is why this is safe to run standing."""
    from modules.scheduling import router as scheduling_router

    job_id = int(payload["job_id"])
    job_dict = scheduling_router.update_job(
        job_id,
        scheduling_router.JobUpdate(open_for_claims=True),
        db=db,
        org_id=org_id,
    )
    return {"job_id": job_id,
            "open_for_claims": bool((job_dict or {}).get("open_for_claims", True))}


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


def _execute_create_job_from_gcal(db: Session, org_id: int, payload: dict) -> dict:
    """Promote a matched-but-unlinked Google Calendar event into a real Job
    via the EXISTING write path: scheduling's create_job — the exact function
    JobCreateModal.jsx hits when a human creates a job. Its conflict/
    duplicate/capacity guards and the Google Calendar push ride along, which
    the raw `Job(...)` insert this replaces (gcal_sync.py) bypassed entirely
    (scheduling-invariants R2: no canonical writes from a projection read).

    gcal_event_id/gcal_ical_uid travel on JobCreate (additive fields — see
    modules/scheduling/router.py) so create_job stamps them on the new Job in
    the same write, and skips re-pushing a duplicate event to Google: the
    event already exists there, it's what this proposal was matched from.
    That stamped id is what lets the next sync_calendar() poll find this Job
    via its existing `Job.gcal_event_id` lookup and take the already-linked
    branch instead of proposing again."""
    from modules.scheduling import router as scheduling_router

    job_data = scheduling_router.JobCreate(
        client_id=int(payload["client_id"]),
        title=str(payload["title"]),
        job_type=payload.get("job_type") or "residential",
        scheduled_date=str(payload["scheduled_date"]),
        start_time=str(payload["start_time"]),
        end_time=str(payload["end_time"]),
        address=payload.get("address"),
        property_id=payload.get("property_id"),
        notes=payload.get("notes"),
        gcal_event_id=str(payload["gcal_event_id"]),
        gcal_ical_uid=payload.get("gcal_ical_uid"),
    )
    job_dict = scheduling_router.create_job(job_data, db=db, org_id=org_id)
    return {
        "job_id": (job_dict or {}).get("id"),
        "gcal_event_id": payload["gcal_event_id"],
        "client_id": payload["client_id"],
    }


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


# The only parts of a pending proposal a human may change before approving it,
# by kind. Approving a drafted message you cannot touch is not a decision —
# it's take-it-or-leave-it, and the leave-it branch means writing the whole
# thing yourself, which is worse than no draft at all. So a drafted `send_sms`
# body is editable; nothing structural is, because everything else in a
# payload (which job, which cleaner, which conversation) IS the proposal, and
# changing it would make the title and detail on screen describe something
# that is no longer what will happen.
EDITABLE_FIELDS = {
    "send_sms": ("body",),
}


def update_proposal_payload(db: Session, proposal: ProposedAction,
                            patch: dict) -> ProposedAction:
    """Edit a PENDING proposal's payload in place, restricted to the fields
    EDITABLE_FIELDS allows for its kind.

    Pending-only (409 otherwise) for the same reason approve and dismiss are:
    once it's decided, the payload is the record of what was actually run.
    Unknown keys are refused rather than dropped — silently ignoring an edit
    the caller believed it made is how a customer gets sent the wrong text."""
    if proposal.status != "pending":
        raise HTTPException(status_code=409,
                            detail=f"Proposal is not pending (status: {proposal.status})")

    allowed = EDITABLE_FIELDS.get(proposal.kind, ())
    if not allowed:
        raise HTTPException(
            status_code=422,
            detail=f"A '{proposal.kind}' proposal can't be edited — approve or dismiss it.")

    patch = dict(patch or {})
    unknown = [k for k in patch if k not in allowed]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Can't edit {', '.join(sorted(unknown))} on a "
                   f"'{proposal.kind}' proposal (editable: {', '.join(allowed)})")
    if not patch:
        return proposal

    merged = dict(proposal.payload or {})
    merged.update({k: v for k, v in patch.items()})
    try:
        _validate_payload(proposal.kind, merged)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Reassign rather than mutate: a JSON column tracks changes by identity,
    # so an in-place update of the existing dict would not be flushed.
    proposal.payload = merged
    db.commit()
    db.refresh(proposal)
    return proposal
