"""
Overdue-invoice dunning service (T-03).

Finds invoices past their due_date, sends the existing overdue-styled
invoice email via integrations.email.build_invoice_email (the template
already renders a red "OVERDUE INVOICE" header), and advances a per-
invoice `dunning_stage` counter so cleaner sees exactly one nudge per
cadence step.

Cadence (default): +1 day, +7 days, +14 days past due. Once stage 3
fires we stop; a manual re-send doesn't rewind the counter, so
operators can still hit the "Send" button on an overdue invoice
without the tick immediately re-nudging.

Gates (same shape as the SMS-reminders service in reminder_service.py):
  - services.dunning_service.send_due_dunning() checks nothing on its
    own — the scheduler tick is where the JOB_DUNNING_ENABLED env / DB
    `dunning_enabled` app_setting are consulted. Keeping the service
    itself gate-free makes it directly callable for manual "chase now"
    from the frontend later without duplicating the check.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone, date as date_cls

from sqlalchemy.orm import Session

from database.models import Invoice, Client, Message
from integrations.email import send_email, build_invoice_email

logger = logging.getLogger(__name__)


# Days-past-due that trigger each stage. Ordered so index+1 == stage.
DEFAULT_CADENCE_DAYS = (1, 7, 14)


def _cadence() -> tuple[int, ...]:
    """Optional env override so an operator can tune the cadence without
    a redeploy. Format: comma-separated integers. Falls back to
    DEFAULT_CADENCE_DAYS on parse error."""
    raw = os.getenv("JOB_DUNNING_CADENCE_DAYS", "").strip()
    if not raw:
        return DEFAULT_CADENCE_DAYS
    try:
        parsed = tuple(int(x.strip()) for x in raw.split(",") if x.strip())
        return parsed or DEFAULT_CADENCE_DAYS
    except (ValueError, TypeError):
        logger.warning("Invalid JOB_DUNNING_CADENCE_DAYS=%r; using default", raw)
        return DEFAULT_CADENCE_DAYS


def _due_stage(days_past_due: int, cadence: tuple[int, ...], current_stage: int) -> int | None:
    """Given how many days past due an invoice is, its current dunning
    stage, and the cadence, return the NEXT stage to fire (1-indexed),
    or None if nothing's due yet or the final has already fired.

    Only ever advances the counter by one at a time — if an invoice was
    somehow silent past two cadence steps (deploy off, DB flag off), we
    still start with stage 1 rather than skipping straight to stage 3.
    That keeps the customer's first automatic touch a soft nudge, not
    the final notice.
    """
    if current_stage >= len(cadence):
        return None                          # final already fired
    next_stage = current_stage + 1
    threshold = cadence[current_stage]       # cadence is 0-indexed
    if days_past_due < threshold:
        return None                          # not due to fire yet
    return next_stage


def _days_past_due(due_date_str: str | None, today: date_cls) -> int | None:
    """Parse Invoice.due_date (stored as string) and return days past due,
    or None if the date is missing/malformed."""
    if not due_date_str:
        return None
    try:
        due = datetime.strptime(str(due_date_str)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None
    return (today - due).days


def _invoice_to_email_dict(inv: Invoice) -> dict:
    """Minimal shape build_invoice_email consumes. Kept inline so we don't
    couple this service to the invoicing router's `invoice_to_dict`."""
    return {
        "id": inv.id,
        "invoice_number": inv.invoice_number,
        "items": inv.items or [],
        "subtotal": inv.subtotal or 0,
        "tax_rate": inv.tax_rate or 0,
        "tax": inv.tax or 0,
        "total": inv.total or 0,
        "status": "overdue",
        "due_date": inv.due_date,
        "notes": inv.notes,
    }


def _record_outbound_message(db: Session, inv: Invoice, to_email: str, stage: int) -> None:
    """Log the send in the shared Message table so it appears in the
    unified inbox — same pattern reminder_service uses for SMS
    reminders."""
    msg = Message(
        client_id=inv.client_id,
        channel="email",
        direction="outbound",
        from_addr=os.getenv("SMTP_USER", ""),
        to_addr=to_email,
        body=f"Overdue reminder #{stage} for invoice {inv.invoice_number or inv.id}",
        status="sent",
        author="system:dunning",
        org_id=inv.org_id,  # BB-MT-01
    )
    db.add(msg)


def send_due_dunning(
    db: Session,
    *,
    now: datetime | None = None,
    cadence: tuple[int, ...] | None = None,
) -> dict:
    """Find invoices due for an automatic overdue chase and send. Returns
    a summary dict: {candidates, sent, skipped_no_email, failed, stage_advanced}.

    Idempotency: each stage advances Invoice.dunning_stage. A second tick
    the same day (or an operator hitting Send manually) won't re-fire the
    same stage. Paid invoices are excluded up-front so a marked-paid
    invoice can't be re-dunned.
    """
    now = now or datetime.now(timezone.utc)
    today = now.date()
    cadence = cadence or _cadence()

    candidates = (
        db.query(Invoice)
        .filter(Invoice.status.in_(("sent", "overdue")))
        .filter(Invoice.due_date.isnot(None))
        .filter(Invoice.dunning_stage < len(cadence))
        .all()
    )

    sent = skipped_no_email = failed = stage_advanced = 0
    for inv in candidates:
        days = _days_past_due(inv.due_date, today)
        if days is None or days < cadence[0]:
            continue
        current_stage = int(inv.dunning_stage or 0)
        next_stage = _due_stage(days, cadence, current_stage)
        if next_stage is None:
            continue
        stage_advanced += 1

        client = inv.client or (db.query(Client).filter(Client.id == inv.client_id).first()
                                if inv.client_id else None)
        to_email = (client.email if client else None) or ""
        if not to_email.strip():
            skipped_no_email += 1
            # Still advance the stage — otherwise every future tick would
            # burn cycles on the same emailless invoice.
            inv.dunning_stage = next_stage
            inv.dunning_last_sent_at = now
            db.commit()
            continue

        client_name = client.name if client else f"Client #{inv.client_id}"
        try:
            html, plain = build_invoice_email(
                _invoice_to_email_dict(inv), client_name,
                os.getenv("TWILIO_PHONE_NUMBER", ""),
            )
            subject = (
                f"Overdue: Invoice {inv.invoice_number or inv.id} "
                f"({days} days past due)"
            )
            send_email(to=to_email, subject=subject, html_body=html, text_body=plain)
        except Exception as e:
            logger.warning("[dunning] invoice #%s send failed: %s", inv.id, e)
            failed += 1
            continue

        # Advance FIRST so a crash inside message-logging doesn't cause a
        # double-send on the next tick. Best-effort log the message row.
        inv.dunning_stage = next_stage
        inv.dunning_last_sent_at = now
        # Flip status to "overdue" if it was still "sent"; keeps the
        # billing list in sync with the automated chase.
        if inv.status == "sent":
            inv.status = "overdue"
        try:
            _record_outbound_message(db, inv, to_email, next_stage)
        except Exception as e:
            logger.warning("[dunning] invoice #%s message-log failed (non-fatal): %s", inv.id, e)
        db.commit()
        sent += 1

    return {
        "candidates": len(candidates),
        "stage_advanced": stage_advanced,
        "sent": sent,
        "skipped_no_email": skipped_no_email,
        "failed": failed,
        "cadence_days": list(cadence),
    }
