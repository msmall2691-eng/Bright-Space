"""
iCal sync engine — fetches Airbnb/VRBO iCal feeds and auto-creates turnover jobs.

Flow:
  1. Fetch iCal URL for a Property
  2. Parse VEVENT blocks — each reservation is one or more events
  3. For each event: upsert ICalEvent row (property_id + uid unique constraint handles dedup)
  4. For events that don't have a Job yet and checkout is in the future: create a Job
  5. Push new turnover jobs to Google Calendar (GCal is source of truth for scheduling)
     — property owner gets the event as an invite in their calendar
"""

import httpx
from icalendar import Calendar
from datetime import datetime, date, timedelta
from sqlalchemy.orm import Session
from database.models import Property, ICalEvent, Job, Client
import logging

log = logging.getLogger(__name__)


def _parse_date(val) -> str | None:
    """Convert icalendar date/datetime to YYYY-MM-DD string."""
    if val is None:
        return None
    if hasattr(val, "dt"):
        val = val.dt
    if isinstance(val, datetime):
        return val.date().isoformat()
    if isinstance(val, date):
        return val.isoformat()
    return str(val)


def _make_end_time(start_time: str, duration_hours: float) -> str:
    """Calculate HH:MM end time from start time + duration."""
    h, m = map(int, start_time.split(":"))
    total_minutes = h * 60 + m + int(duration_hours * 60)
    return f"{(total_minutes // 60) % 24:02d}:{total_minutes % 60:02d}"


async def fetch_ical(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


def sync_property(db: Session, prop: Property) -> dict:
    """
    Sync one property's iCal feed. Returns summary dict.
    Designed to be called from an API route or background task.
    """
    if not prop.ical_url:
        return {"error": "No iCal URL configured for this property"}

    # Fetch feed (sync wrapper — call from async context with asyncio.run or use await fetch_ical)
    import httpx as _httpx
    try:
        with _httpx.Client(timeout=15) as client:
            r = client.get(prop.ical_url)
            r.raise_for_status()
            raw = r.content
    except Exception as e:
        return {"error": f"Failed to fetch iCal: {e}"}

    # Parse
    try:
        cal = Calendar.from_ical(raw)
    except Exception as e:
        return {"error": f"Failed to parse iCal: {e}"}

    today = date.today().isoformat()
    seen = 0
    created_events = 0
    created_jobs = 0
    skipped = 0

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        uid = str(component.get("UID", ""))
        if not uid:
            continue

        summary = str(component.get("SUMMARY", ""))
        checkout = _parse_date(component.get("DTEND"))
        checkin = _parse_date(component.get("DTSTART"))

        # Skip events with no checkout or that are pure "Not available" blocks
        # Airbnb also emits "Airbnb (BLOCKED)" events — those are owner blocks, skip them
        low = summary.lower()
        if not checkout or "blocked" in low or "unavailable" in low:
            skipped += 1
            continue

        seen += 1

        # Upsert ICalEvent
        event = db.query(ICalEvent).filter_by(
            property_id=prop.id, uid=uid
        ).first()

        if not event:
            event = ICalEvent(
                property_id=prop.id,
                uid=uid,
                summary=summary,
                checkout_date=checkout,
                checkin_date=checkin,
                raw_event={"uid": uid, "summary": summary, "checkout": checkout, "checkin": checkin},
            )
            db.add(event)
            db.flush()  # get event.id
            created_events += 1

        # Create a Job if: no job yet + checkout is today or future
        if event.job_id is None and checkout >= today:
            # Default start time = 10:00 AM on checkout day
            start_time = "10:00"
            end_time = _make_end_time(start_time, prop.default_duration_hours)

            # Get client (property owner) for GCal invite
            client = db.query(Client).filter_by(id=prop.client_id).first()
            client_name = client.name if client else "Client"

            job = Job(
                client_id=prop.client_id,
                property_id=prop.id,
                job_type="str_turnover",
                title=f"Turnover — {prop.name}",
                scheduled_date=checkout,
                start_time=start_time,
                end_time=end_time,
                address=prop.address,
                notes=f"Guest checkout. Booking: {summary}",
                status="scheduled",
            )
            db.add(job)
            db.flush()

            event.job_id = job.id
            created_jobs += 1

            # Push to Google Calendar — GCal is the source of truth.
            # The property owner gets this as a calendar invite.
            try:
                from integrations.google_calendar import create_event
                job_dict = {
                    "id": job.id, "title": job.title, "job_type": "str_turnover",
                    "scheduled_date": checkout, "start_time": start_time,
                    "end_time": end_time, "address": prop.address,
                    "notes": f"Guest checkout. Booking: {summary}",
                    "property_id": prop.id,
                }
                client_dict = {
                    "id": prop.client_id,
                    "name": client_name,
                    "email": getattr(client, "email", None) if client else None,
                }
                gcal_event_id = create_event(job_dict, client_dict)
                if gcal_event_id:
                    job.gcal_event_id = gcal_event_id
                    job.calendar_invite_sent = True
                    log.info(f"Pushed turnover to GCal: {prop.name} on {checkout} (event={gcal_event_id})")
            except Exception as e:
                log.warning(f"Failed to push turnover to GCal for {prop.name} on {checkout}: {e}")

    # Update sync timestamp
    prop.ical_last_synced_at = datetime.utcnow()
    db.commit()

    return {
        "property_id": prop.id,
        "property_name": prop.name,
        "events_seen": seen,
        "events_created": created_events,
        "jobs_created": created_jobs,
        "skipped": skipped,
        "synced_at": prop.ical_last_synced_at.isoformat(),
    }
