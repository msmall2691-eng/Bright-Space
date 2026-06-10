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
    commit: bool = True,
) -> None:
    """Record an outbound integration attempt. Best-effort, never raises.

    `detail` is a single free-text note routed to the right column on the
    existing integration_events table (scaffolded in 001): on a failed status it
    lands in error_message; otherwise it's kept as a request note (e.g. the
    recipient address). Truncated to 1000 chars.
    """
    try:
        from database.models import IntegrationEvent
        note = (str(detail)[:1000] if detail is not None else None)
        is_failure = str(status).lower() in ("failed", "error")
        row = IntegrationEvent(
            entity_type=entity_type,
            entity_id=entity_id,
            provider=provider,
            action=action,
            status=status,
            external_id=str(external_id) if external_id is not None else None,
            error_message=note if (is_failure and note) else None,
            request_payload=note if (not is_failure and note) else None,
        )
        db.add(row)
        if commit:
            db.commit()
    except Exception as e:  # pragma: no cover - logging must never break callers
        logger.warning("[integration-log] failed to record %s/%s for %s %s: %s",
                       provider, action, entity_type, entity_id, e)
        try:
            db.rollback()
        except Exception:
            pass
