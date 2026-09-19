"""Every outbound SMS routes through here so every attempt lands on the
integration audit log (provider "sms"). The SMS activity read and the Settings
"Text messages" card then show the whole picture — reminders, invoices, notices,
comms, crew — not just booking confirmations and owner alerts.

Thin and side-channel by design:
  * it calls integrations.twilio_client.send_sms and returns its result
    UNCHANGED, and RE-RAISES the same exception on failure — so every existing
    caller's try/except and result handling keep working exactly as before;
  * the audit row is written in its OWN short-lived session, so it never
    commits the caller's pending work early, and it survives even when the
    caller rolls back — a failed send is the row you most want to keep.

Channels that already log their own SMS attempts keep doing so and must NOT be
routed through here, or they would double-log: the booking customer
confirmation (services.sms_guard.record_send), the owner alerts
(services.owner_alerts.send_owner_sms), and the quote send
(modules.quoting.router._log_integration).
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _audit(*, action, status, to, entity_type, entity_id, org_id, sid=None, error=None):
    """Write one audit row in an isolated session. Best-effort, never raises."""
    from database.db import SessionLocal
    from utils.integration_log import log_integration_event
    s = SessionLocal()
    try:
        log_integration_event(
            s, entity_type=entity_type, entity_id=entity_id, provider="sms",
            action=action, status=status, recipient=to, external_id=sid,
            detail=error, org_id=org_id, commit=True)
    except Exception:  # pragma: no cover - audit must never break a send
        logger.warning("[sms] audit write failed for action=%s", action, exc_info=True)
    finally:
        s.close()


def send_and_log(*, to, body, action, entity_type="sms", entity_id=0, org_id=None):
    """Send one SMS and record the attempt. Returns twilio_client.send_sms's
    result dict on success; logs the failure and re-raises on error, so the
    caller's existing error handling is unchanged."""
    from integrations.twilio_client import send_sms
    try:
        res = send_sms(to=to, body=body)
    except Exception as e:
        _audit(action=action, status="failed", to=to, entity_type=entity_type,
               entity_id=entity_id, org_id=org_id, error=str(e))
        raise
    _audit(action=action, status="ok", to=to, entity_type=entity_type,
           entity_id=entity_id, org_id=org_id, sid=(res or {}).get("sid"))
    return res
