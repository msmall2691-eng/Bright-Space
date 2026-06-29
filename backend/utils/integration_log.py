"""Best-effort audit logging for outbound integrations (GCal / email / SMS).

`log_integration_event` writes one IntegrationEvent row. It must NEVER raise —
recording an action can't be allowed to break the action itself — so every
failure is swallowed (and noted to the logger). Pass commit=False to batch the
write into the caller's existing transaction.
"""
import logging

logger = logging.getLogger(__name__)


def log_integration_event(
    db,
    *,
    entity_type: str,
    entity_id=None,
    provider: str,
    action: str,
    status: str,
    external_id=None,
    detail=None,
    recipient=None,
    commit: bool = True,
) -> None:
    """Record an outbound integration attempt. Best-effort, never raises.

    `detail` is a single free-text note routed to the right column on the
    existing integration_events table (scaffolded in 001): on a failed status it
    lands in error_message; otherwise it's kept as a request note (e.g. the
    recipient address). Truncated to 1000 chars.

    `recipient` is the address/phone the action was sent to. When provided it is
    always stored in request_payload as "to <recipient>" — even on failures —
    so the quote delivery history can show who the send attempt targeted
    regardless of outcome.
    """
    try:
        from database.models import IntegrationEvent
        note = (str(detail)[:1000] if detail is not None else None)
        is_failure = str(status).lower() in ("failed", "error")
        recipient_note = f"to {recipient}" if recipient else None
        # request_payload prefers the structured recipient; falls back to the
        # caller's free-text note when no recipient is given.
        rp = recipient_note or (note if not is_failure else None)
        row = IntegrationEvent(
            entity_type=entity_type,
            entity_id=entity_id,
            provider=provider,
            action=action,
            status=status,
            external_id=str(external_id) if external_id is not None else None,
            error_message=note if (is_failure and note) else None,
            request_payload=rp,
        )
        if commit:
            db.add(row)
            db.commit()
        else:
            # Savepoint: flush the row HERE so a bad insert rolls back only
            # the audit row, never the caller's transaction. Without this the
            # deferred INSERT failed at the caller's commit (June 11: prod
            # integration_events payload columns had drifted to json) and
            # rolled back delivery bookkeeping — the quote stayed 'draft'
            # while the customer DID get the email.
            with db.begin_nested():
                db.add(row)
    except Exception as e:  # pragma: no cover - logging must never break callers
        logger.warning("[integration-log] failed to record %s/%s for %s %s: %s",
                       provider, action, entity_type, entity_id, e)
        if commit:
            # Only safe when we own the transaction; with commit=False the
            # savepoint already rolled back and the caller's work must survive.
            try:
                db.rollback()
            except Exception:
                pass
