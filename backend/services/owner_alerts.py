"""Owner alert channels — the ONE place that knows where to reach the owner.

Booking, intake and quote events all want the same thing: "text and email the
owner about this". The destination rules (Settings row first, env var as the
deploy-time fallback) and the best-effort send contract used to live in
modules/booking/router.py; intake and quoting needed them too, and importing
a router from a router just to borrow a helper is how circular imports start.

Contract shared by both channels:
  * returns True only when a message was actually handed to the provider,
  * returns False when nothing is configured (logged at INFO, not WARNING —
    an unconfigured deploy shouldn't log noise on every event),
  * raises on a provider failure — callers wrap in try/except so the
    customer-facing response never depends on an alert.

Lookup: Settings ``owner_alert_phone`` → env ``OWNER_ALERT_PHONE``;
Settings ``owner_alert_email`` → env ``OWNER_ALERT_EMAIL``.
"""
import logging
import os
from html import escape as _esc
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def owner_notify_setting(db: Session, key: str, env_var: str) -> Optional[str]:
    """Owner-notification destination: the Settings row first (operator can
    edit it in BrightBase without a redeploy), then the env var as the
    deploy-time fallback. Shared by the owner SMS (owner_alert_phone /
    OWNER_ALERT_PHONE) and owner email (owner_alert_email / OWNER_ALERT_EMAIL)
    paths so the two channels can't drift on lookup rules."""
    value = None
    try:
        from database.models import AppSetting
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        if row and (row.value or "").strip():
            value = row.value.strip()
    except Exception:
        pass
    return value or (os.getenv(env_var) or "").strip() or None


def owner_alert_phone(db: Session) -> Optional[str]:
    return owner_notify_setting(db, "owner_alert_phone", "OWNER_ALERT_PHONE")


def owner_alert_email(db: Session) -> Optional[str]:
    return owner_notify_setting(db, "owner_alert_email", "OWNER_ALERT_EMAIL")


def send_owner_sms(db: Session, body: str, *, ref: str = "", tag: str = "owner-alert",
                   entity_type: str = "owner_alert", entity_id=None) -> bool:
    """Text the owner via the same integrations.twilio_client the quote-SMS
    path uses, so one TWILIO_* configuration covers every owner alert.
    ``ref`` is a log-only identifier (e.g. "intake=12", "quote=QT-7").

    Every ATTEMPT is written to the integration audit log (provider "sms",
    action "owner_alert") so the SMS activity read (GET /api/integration-events
    ?provider=sms) shows owner-alert texts alongside the customer booking SMS —
    which is how an operator sees why a lead text did or didn't arrive. The
    unconfigured case is not an attempt (no destination), so it stays a plain
    INFO log rather than a failed row on every lead. Raises on a provider
    failure after logging it — callers wrap this (best-effort contract)."""
    to_number = owner_alert_phone(db)
    if not to_number:
        logger.info("[%s] owner SMS skipped — no owner_alert_phone / OWNER_ALERT_PHONE set", tag)
        return False
    from integrations.twilio_client import send_sms
    from utils.integration_log import log_integration_event
    try:
        res = send_sms(to=to_number, body=body)
    except Exception as e:
        log_integration_event(
            db, entity_type=entity_type, entity_id=entity_id, provider="sms",
            action="owner_alert", status="failed", recipient=to_number,
            detail=str(e), commit=True)
        raise
    log_integration_event(
        db, entity_type=entity_type, entity_id=entity_id, provider="sms",
        action="owner_alert", status="ok", recipient=to_number,
        external_id=(res or {}).get("sid"), commit=True)
    logger.info("[%s] owner SMS sent %s", tag, ref)
    return True


def send_owner_email(db: Session, subject: str, lines: list, *, ref: str = "",
                     tag: str = "owner-alert") -> bool:
    """Email the owner a short plain summary. Deliberately plain (short
    lines, no template): this is an internal operator ping, not a branded
    customer receipt."""
    to_email = owner_alert_email(db)
    if not to_email:
        logger.info("[%s] owner email skipped — no owner_alert_email / OWNER_ALERT_EMAIL set", tag)
        return False
    from integrations.email import send_email
    text_lines = [str(l) for l in lines if l]
    html_body = (
        '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">'
        + "<br>".join(_esc(l) for l in text_lines)
        + "</div>"
    )
    send_email(to=to_email, subject=subject, html_body=html_body, text_body="\n".join(text_lines))
    logger.info("[%s] owner email sent %s", tag, ref)
    return True
