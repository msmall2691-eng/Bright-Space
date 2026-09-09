"""Tell the customer their cleaning is on the calendar (BB-CUST-01).

The gap this closes: a customer books through the website, gets a "we'll
confirm within one business day" receipt — and then hears nothing until the
24-hour reminder the night before, even though the office scheduled them days
earlier. This fires ONCE, at the moment a job actually becomes scheduled, on
both channels (a text and an email), with the date, the time, and a link to
the confirm page where "who's coming" and the reschedule flow already live.

Design, following the booking-confirmation precedent in modules/booking:
  * OFF by default. It reaches a real customer, so it answers to the standing
    rule `customer_scheduled_notice` (Settings → Rules) and sends nothing until
    the owner turns it on — the same posture as the 24h reminder and dunning.
  * Event-driven at the schedule write, never a tick (scheduling-invariants R1).
    The callers fire it exactly on the transition INTO scheduled, so a customer
    is not re-notified when an already-scheduled job is edited.
  * Best-effort and self-contained: a missing phone/email, unconfigured Twilio
    or SMTP, or a send failure all log and return — the schedule write that
    triggered it has already committed and must never depend on this.
  * NO access details, ever (BB-SEC-08…12): the message carries the day, the
    time window, and the confirm link — never the address, gate code, or notes.
    Who's coming is shown on the linked page (via crew_intro), not inlined here,
    because at schedule time a cleaner is usually not assigned yet.
"""
from __future__ import annotations

import logging
import os
import secrets

from sqlalchemy.orm import Session

from config import app_base_url

logger = logging.getLogger(__name__)


def _fmt_time(t) -> str:
    """'9:00 AM' from a datetime.time or 'HH:MM' string; '' if unknown."""
    if t is None:
        return ""
    try:
        if isinstance(t, str):
            parts = t.split(":")
            hour, minute = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
        else:
            hour, minute = t.hour, t.minute
        h12 = hour % 12 or 12
        ampm = "AM" if hour < 12 else "PM"
        return f"{h12}:{minute:02d} {ampm}"
    except Exception:
        return str(t)


def _when_phrase(job) -> str:
    """'Tuesday, September 15 at 9:00 AM' — date always, time when known."""
    d = job.scheduled_date
    day = d.strftime("%A, %B %-d") if hasattr(d, "strftime") else str(d)
    t = _fmt_time(getattr(job, "start_time", None))
    return f"{day} at {t}" if t else day


def _confirm_url(db: Session, job) -> str:
    """The public confirm-link URL, minting the token if the job lacks one.

    Mirrors reminder_service: the token is how a customer reaches the visit
    page with no login. Committed here because this runs post-commit, after the
    caller's own transaction has closed."""
    if not job.public_token:
        job.public_token = secrets.token_urlsafe(32)
        db.commit()
    return f"{app_base_url().rstrip('/')}/job/{job.public_token}"


def _thread_outbound(db: Session, job, client, body: str, sid) -> None:
    """Record the text in the customer's SMS conversation so it shows in the
    unified inbox, exactly like the 24h reminder does — not an invisible
    side-channel send. Best-effort; lazy import avoids a comms import cycle."""
    from database.models import Message
    from modules.comms.router import (
        find_or_create_conversation, _apply_outbound, _normalize_contact,
    )
    to_norm = _normalize_contact(client.phone)
    conv = find_or_create_conversation(
        db, channel="sms", client_id=client.id,
        external_contact=to_norm, org_id=client.org_id,
    )
    if conv.client_id is None:
        conv.client_id = client.id
    msg = Message(
        client_id=client.id, conversation_id=conv.id, channel="sms",
        direction="outbound",
        from_addr=_normalize_contact(os.getenv("TWILIO_PHONE_NUMBER", "")),
        to_addr=to_norm, body=body, status="sent", external_id=sid,
        author="system:scheduled-notice", org_id=client.org_id,  # BB-MT-01
    )
    db.add(msg)
    db.flush()
    _apply_outbound(conv, msg)


def _send_sms(db: Session, job, client, when: str, link: str) -> None:
    from integrations.twilio_client import send_sms
    first = (getattr(client, "first_name", None) or client.name or "there").strip()
    body = (f"Hi {first}, you're booked in for a cleaning on {when}. "
            f"See details or request a change: {link} — The Maine Cleaning Co.")
    try:
        result = send_sms(to=client.phone, body=body)
    except (ValueError, RuntimeError) as e:
        # Unconfigured Twilio or a bad number is environmental — log and move on.
        logger.info("[scheduled-notice] SMS skipped for job %s: %s", job.id, e)
        return
    try:
        _thread_outbound(db, job, client, body, (result or {}).get("sid"))
        db.commit()
    except Exception as e:
        logger.warning("[scheduled-notice] inbox-thread failed for job %s: %s", job.id, e)


def _send_email(job, client, when: str, link: str) -> None:
    from html import escape as esc
    from integrations.email import send_email
    first = (getattr(client, "first_name", None) or client.name or "there").strip()
    subject = f"You're booked in — {when}"
    text_body = (
        f"Hi {first},\n\n"
        f"Your cleaning is on the calendar for {when}.\n\n"
        f"See the details, meet who's coming, or request a change here:\n{link}\n\n"
        f"— The Maine Cleaning Co."
    )
    html_body = (
        f"<p>Hi {esc(first)},</p>"
        f"<p>Your cleaning is on the calendar for <strong>{esc(when)}</strong>.</p>"
        f"<p><a href=\"{esc(link)}\">See the details, meet who's coming, or "
        f"request a change</a>.</p>"
        f"<p>— The Maine Cleaning Co.</p>"
    )
    try:
        send_email(to=client.email, subject=subject, html_body=html_body, text_body=text_body)
    except (ValueError, RuntimeError) as e:
        logger.info("[scheduled-notice] email skipped for job %s: %s", job.id, e)


def notify_customer_scheduled(db: Session, job) -> None:
    """Send the "you're booked in" text + email — once, when a job becomes
    scheduled. Gated OFF by default; best-effort on both channels; carries no
    access details. Safe to call post-commit from any schedule write site."""
    try:
        from services.standing_rules import customer_scheduled_notice_enabled
        if not customer_scheduled_notice_enabled(db):
            return
        if getattr(job, "status", None) != "scheduled" or not getattr(job, "scheduled_date", None):
            return
        client = getattr(job, "client", None)
        if client is None and getattr(job, "client_id", None):
            from database.models import Client
            client = db.query(Client).filter(Client.id == job.client_id).first()
        if client is None:
            return

        when = _when_phrase(job)
        link = _confirm_url(db, job)
        if (getattr(client, "phone", None) or "").strip():
            _send_sms(db, job, client, when, link)
        email = (getattr(client, "email", None) or "").strip()
        if email and "@" in email:
            _send_email(job, client, when, link)
    except Exception:  # pragma: no cover - a customer notice must never break a schedule write
        logger.warning("[scheduled-notice] failed for job %s", getattr(job, "id", "?"), exc_info=True)
