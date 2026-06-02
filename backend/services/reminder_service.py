"""
Job SMS reminder service.

Sends clients an SMS reminder ahead of an upcoming cleaning. The Job model has
carried an unused ``sms_reminder_sent`` flag since the schema was first written;
this is the implementation that finally uses it as the idempotency guard so a
client is never texted twice for the same job.

Design notes:
- Outward-facing (texts real customers), so it is OFF by default and gated by
  JOB_SMS_REMINDERS_ENABLED / the ``job_sms_reminders_enabled`` app_setting,
  mirroring the iCal/GCal/recurring scheduler jobs.
- Reuses the existing Twilio client and threads the sent reminder into the
  comms inbox (find_or_create_conversation + _apply_outbound) so it shows up in
  the unified conversation thread exactly like a manual SMS, rather than being
  an invisible side-channel send.
- The reminder window is [now, now + lead_hours]. With the default 24h lead and
  an hourly tick, each upcoming job gets exactly one reminder roughly a day out.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone, date as date_cls

from sqlalchemy.orm import Session

from database.models import Job, Client, Conversation, Message
from integrations.twilio_client import send_sms

logger = logging.getLogger(__name__)


def _lead_hours() -> int:
    try:
        return int(os.getenv("JOB_SMS_REMINDER_LEAD_HOURS", "24"))
    except (ValueError, TypeError):
        return 24


def _format_time(t) -> str:
    """Render a time column (datetime.time or 'HH:MM[:SS]' string) as e.g. '2:00 PM'."""
    if t is None:
        return ""
    try:
        if isinstance(t, str):
            parts = t.split(":")
            t = datetime.now().replace(
                hour=int(parts[0]), minute=int(parts[1]) if len(parts) > 1 else 0
            ).time()
        hour = t.hour % 12 or 12
        ampm = "AM" if t.hour < 12 else "PM"
        return f"{hour}:{t.minute:02d} {ampm}"
    except Exception:
        return str(t)


def build_reminder_body(job: Job, client: Client) -> str:
    """Compose the client-facing reminder text. Kept small + plain so it reads
    well as a single SMS segment for the common case."""
    first = (client.first_name or client.name or "there").strip()
    when_time = _format_time(job.start_time)
    when = f"tomorrow at {when_time}" if when_time else "tomorrow"
    where = ""
    if job.property and getattr(job.property, "name", None):
        where = f" at {job.property.name}"
    elif job.address:
        where = f" at {job.address}"
    return (
        f"Hi {first}, this is a reminder for your cleaning {when}{where}. "
        "Reply here if you need to reschedule. Thanks!"
    )


def _thread_outbound_reminder(db: Session, job: Job, client: Client, body: str, sid):
    """Record the reminder as an outbound message in the client's email/SMS
    conversation so it's visible in the unified inbox. Lazy import avoids a
    module-load cycle with the comms router."""
    from modules.comms.router import (
        find_or_create_conversation, _apply_outbound, _normalize_contact,
    )
    to_normalized = _normalize_contact(client.phone)
    conv = find_or_create_conversation(
        db, channel="sms",
        client_id=client.id,
        external_contact=to_normalized,
    )
    if conv.client_id is None:
        conv.client_id = client.id
    msg = Message(
        client_id=client.id,
        conversation_id=conv.id,
        channel="sms",
        direction="outbound",
        from_addr=_normalize_contact(os.getenv("TWILIO_PHONE_NUMBER", "")),
        to_addr=to_normalized,
        body=body,
        status="sent",
        external_id=sid,
        author="system:reminder",
    )
    db.add(msg)
    db.flush()
    _apply_outbound(conv, msg)


def send_due_reminders(db: Session, *, lead_hours: int | None = None, now: datetime | None = None) -> dict:
    """Find scheduled jobs starting within the lead window that haven't been
    reminded yet, text the client, and mark sms_reminder_sent.

    Returns a summary dict: {sent, skipped_no_phone, failed, candidates}.
    """
    lead = lead_hours if lead_hours is not None else _lead_hours()
    now = now or datetime.now(timezone.utc)
    today = now.date()
    window_end = (now + timedelta(hours=lead)).date()

    # Candidate jobs: scheduled, not yet reminded, with a date in [today, window_end].
    # Date-grained (jobs store a Date + Time) — fine for a daily-ahead reminder.
    candidates = (
        db.query(Job)
        .filter(
            Job.status == "scheduled",
            Job.sms_reminder_sent.is_(False),
            Job.skip_sms_reminder.is_(False),  # per-job opt-out (hybrid model)
            Job.scheduled_date.isnot(None),
            Job.scheduled_date >= today,
            Job.scheduled_date <= window_end,
        )
        .all()
    )

    sent = skipped_no_phone = failed = 0
    for job in candidates:
        client = job.client
        if client is None and job.client_id:
            client = db.query(Client).filter(Client.id == job.client_id).first()
        if not client or not (client.phone or "").strip():
            skipped_no_phone += 1
            continue

        body = build_reminder_body(job, client)
        try:
            result = send_sms(to=client.phone, body=body)
        except (ValueError, RuntimeError) as e:
            # Config/Twilio errors are environmental — log and move on so one
            # bad number/outage doesn't block the rest of the batch. Leave the
            # flag unset so it retries on the next tick.
            logger.warning(f"[reminders] job #{job.id} send failed: {e}")
            failed += 1
            continue

        # Mark sent FIRST (idempotency), then best-effort thread into the inbox.
        job.sms_reminder_sent = True
        try:
            _thread_outbound_reminder(db, job, client, body, result.get("sid"))
        except Exception as e:
            logger.warning(f"[reminders] job #{job.id} inbox-thread failed (non-fatal): {e}")
        db.commit()
        sent += 1

    return {
        "candidates": len(candidates),
        "sent": sent,
        "skipped_no_phone": skipped_no_phone,
        "failed": failed,
    }
