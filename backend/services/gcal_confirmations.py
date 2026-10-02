"""Capture a customer's Google Calendar RSVP as a visit confirmation.

When the office invites a customer to a job's calendar event (the manual
"invite the customer" action), the customer can RSVP "Yes" in their own Google/
calendar client. That acceptance is a *confirmation signal* — the same thing the
tap-to-confirm link in the reminder text produces — so we fold it into the one
field the whole app already reads, ``Job.customer_confirmed_at``.

Why this lives here and reads on demand, not on a tick:

* **scheduling-invariants R2/R7.** Google Calendar is a read-only *projection*,
  never a peer. Reading an attendee's RSVP is not two-way schedule sync: it
  never moves, reassigns, or cancels a Job. We only ever read an *accepted*
  RSVP and stamp a confirmation; a declined/tentative RSVP does nothing to the
  Job (a human decides what a decline means). So this is safe even though the
  two-way sync path is off.
* **scheduling-invariants R1 / brightbase-economy.** No new background tick and
  no polling. The read happens when the office opens the job (``get_job_details``
  calls ``maybe_capture_customer_rsvp`` once), only for a job that actually has
  an invite out and isn't confirmed yet, and the result is cached at the row:
  once ``customer_confirmed_at`` is set we never fetch again. One metered call
  per view per need, and zero once confirmed.
* **Fails open.** Any Google/config error returns False and never raises, so a
  calendar hiccup can never break the job page.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_ACCEPTED = "accepted"


def maybe_capture_customer_rsvp(db: Session, job) -> bool:
    """If the customer accepted this job's calendar invite, stamp the visit as
    confirmed. Returns True only when it flips an unconfirmed job to confirmed.

    Cheap DB guards first, so the common case (not invited, or already
    confirmed) costs nothing and never touches Google.
    """
    # Already confirmed (via the text link or a prior read), or nothing to read.
    if job is None or job.customer_confirmed_at is not None:
        return False
    if not getattr(job, "calendar_invite_sent", False) or not getattr(job, "gcal_event_id", None):
        return False
    if job.status in ("cancelled", "completed"):
        return False
    client = job.client
    email = (getattr(client, "email", None) or "").strip().lower()
    if not email:
        return False

    try:
        from integrations.google_calendar import get_event, is_configured
        if not is_configured():
            return False
        event = get_event(job.gcal_event_id, job_type=job.job_type or "residential",
                          owner_account_id=getattr(job, "gcal_account_id", None))
    except Exception as e:  # a Google/auth hiccup must never break the job page
        logger.warning("[gcal-rsvp] read failed for job %s: %s", job.id, e)
        return False

    if not event or event.get("status") == "cancelled":
        return False
    if not _customer_accepted(event, email):
        return False

    # Confirmed. Mirror the public tap-to-confirm write (same field, same
    # activity type) so every reader — office, crew, portal — is consistent;
    # only the actor differs, so the timeline shows the customer confirmed via
    # their calendar rather than the link.
    job.customer_confirmed_at = datetime.now(timezone.utc)
    try:
        from utils.activity_logger import log_activity
        log_activity(db, "job_customer_confirmed", job_id=job.id, client_id=job.client_id,
                     actor="google_calendar", org_id=getattr(job, "org_id", None),
                     summary="Customer confirmed the visit (Google Calendar RSVP)", commit=False)
    except Exception:  # logging must not break the confirmation itself
        logger.warning("[gcal-rsvp] activity log failed for job %s", job.id, exc_info=True)
    db.commit()
    logger.info("[gcal-rsvp] job %s confirmed from calendar RSVP", job.id)
    return True


def _customer_accepted(event: dict, client_email: str) -> bool:
    """True iff the client (matched by email) is an attendee who accepted. The
    organizer and crew attendees are ignored — only the customer's own RSVP
    confirms the visit."""
    for att in (event.get("attendees") or []):
        if (att.get("email") or "").strip().lower() != client_email:
            continue
        if att.get("organizer") or att.get("self"):
            return False  # our own account, not the customer
        return (att.get("responseStatus") or "").lower() == _ACCEPTED
    return False
