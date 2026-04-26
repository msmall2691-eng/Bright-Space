"""
iCal sync engine — fetches Airbnb/VRBO iCal feeds and auto-creates turnover jobs.

Flow:
  1. Fetch iCal URL for a Property
  2. Parse VEVENT blocks — each reservation is one or more events
  3. For each event: upsert ICalEvent row (property_id + uid unique constraint handles dedup)
  4. For events where SUMMARY='Reserved' + checkout is in the future: create a turnover Job
  5. Push new turnover jobs to Google Calendar (GCal is source of truth for scheduling)
     — property owner gets the event as an invite in their calendar

RFC 5545 rule: DTEND is EXCLUSIVE for all-day events.
  If a guest checks in April 20 and checks out April 22 morning:
    DTSTART;VALUE=DATE:20260420
    DTEND;VALUE=DATE:20260422
  The guest is NOT on the property April 22. Turnover cleaning happens April 22 (= DTEND).
"""

import httpx
import re
from icalendar import Calendar
from datetime import datetime, date, timedelta, time as time_type
from pytz import timezone as pytz_timezone
from sqlalchemy.orm import Session
from database.models import Property, ICalEvent, Job, Client, PropertyIcal
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


def _extract_guest_metadata(description: str) -> dict:
    """
    Extract AirBnB reservation code and guest phone last-4 from DESCRIPTION.

    AirBnB format example:
      Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCXYZ\n
      Phone Number (Last 4 Digits): 1234
    """
    metadata = {}

    if not description:
        return metadata

    # Extract reservation code from URL
    reservation_match = re.search(
        r'Reservation URL:.*details/([A-Z0-9]+)',
        description,
        re.IGNORECASE
    )
    if reservation_match:
        metadata['airbnb_reservation_code'] = reservation_match.group(1)

    # Extract phone last 4
    phone_match = re.search(
        r'Phone Number \(Last 4 Digits?\):\s*(\d{4})',
        description,
        re.IGNORECASE
    )
    if phone_match:
        metadata['guest_phone_last_4'] = phone_match.group(1)

    return metadata


def _make_end_time(start_time: str, duration_hours: float) -> str:
    """Calculate HH:MM:SS end time from start time + duration."""
    h, m = map(int, start_time.split(":"))
    total_minutes = h * 60 + m + int(duration_hours * 60)
    end_hours = (total_minutes // 60) % 24
    end_minutes = total_minutes % 60
    return f"{end_hours:02d}:{end_minutes:02d}:00"


async def fetch_ical(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


def _sync_ical_url(db: Session, prop: Property, ical_url: str, ical_source_label: str = "unknown", property_ical: PropertyIcal = None) -> dict:
    """
    Sync a single iCal URL. Returns stats dict.

    RFC 5545 fix:
    - DTEND is exclusive for all-day events
    - If DTEND=2026-04-22 and DTSTART=2026-04-20 (VALUE=DATE), guest checks out April 22 morning
    - Turnover cleaning happens April 22 (the checkout date = DTEND value, NO SUBTRACTION)
    """
    # Fetch feed
    import httpx as _httpx
    try:
        with _httpx.Client(timeout=15) as client:
            r = client.get(ical_url)
            r.raise_for_status()
            raw = r.content
    except Exception as e:
        log.warning(f"Failed to fetch iCal from {ical_url}: {e}")
        return {"error": f"Failed to fetch iCal: {e}"}

    # Parse
    try:
        cal = Calendar.from_ical(raw)
    except Exception as e:
        log.warning(f"Failed to parse iCal from {ical_url}: {e}")
        return {"error": f"Failed to parse iCal: {e}"}

    today = date.today().isoformat()
    seen = 0
    created_events = 0
    created_jobs = 0
    skipped_host_blocks = 0
    skipped_not_reserved = 0

    # Collect all events first to enable back-to-back lookup
    events_by_checkout = {}  # For finding next booking
    all_events = []

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        uid = str(component.get("UID", ""))
        if not uid:
            continue

        summary = str(component.get("SUMMARY", ""))
        description = str(component.get("DESCRIPTION", ""))

        # Check SUMMARY — only process "Reserved" (skip "Not available")
        low = summary.lower()
        if "not available" in low or "blocked" in low or "unavailable" in low or "maintenance" in low or "owner" in low:
            skipped_host_blocks += 1
            log.info(f"Skipping host block: {summary}")
            continue

        if "reserved" not in low and "airbnb" not in low:
            skipped_not_reserved += 1
            continue

        # Parse dates
        dtstart_raw = component.get("DTSTART")
        dtend_raw = component.get("DTEND")

        checkin_date = _parse_date(dtstart_raw)
        checkout_raw = _parse_date(dtend_raw)

        # RFC 5545: detect all-day event
        is_all_day = False
        if dtend_raw and hasattr(dtend_raw, "dt"):
            dt_val = dtend_raw.dt
            is_all_day = isinstance(dt_val, date) and not isinstance(dt_val, datetime)

        # CRITICAL FIX: DTEND is exclusive for all-day events
        # Do NOT subtract 1 day. DTEND is the checkout date.
        checkout_date = checkout_raw

        if not checkout_date:
            continue

        seen += 1

        all_events.append({
            'uid': uid,
            'summary': summary,
            'description': description,
            'checkin_date': checkin_date,
            'checkout_date': checkout_date,
            'is_all_day': is_all_day,
            'dtstart_raw': dtstart_raw,
            'dtend_raw': dtend_raw,
        })

        if checkout_date not in events_by_checkout:
            events_by_checkout[checkout_date] = []
        events_by_checkout[checkout_date].append({
            'uid': uid,
            'summary': summary,
            'checkin_date': checkin_date,
            'is_all_day': is_all_day,
        })

    # Now process each event
    for event_data in all_events:
        uid = event_data['uid']
        summary = event_data['summary']
        description = event_data['description']
        checkin_date = event_data['checkin_date']
        checkout_date = event_data['checkout_date']
        is_all_day = event_data['is_all_day']

        # Upsert ICalEvent
        event = db.query(ICalEvent).filter_by(
            property_id=prop.id, uid=uid
        ).first()

        if not event:
            event = ICalEvent(
                property_id=prop.id,
                uid=uid,
                summary=summary,
                event_type="reservation",
                checkout_date=checkout_date,
                checkin_date=checkin_date,
                raw_event={
                    "uid": uid,
                    "summary": summary,
                    "checkout": checkout_date,
                    "checkin": checkin_date,
                    "description": description,
                },
            )
            db.add(event)
            db.flush()
            created_events += 1
        else:
            event.event_type = "reservation"

        # Create a Job if: no job yet + checkout is today or future
        if event.job_id is None and checkout_date >= today:
            # Check for existing job on this date
            existing_job = db.query(Job).filter(
                Job.property_id == prop.id,
                Job.scheduled_date == checkout_date,
                Job.job_type == "str_turnover",
                Job.status.notin_(["cancelled"]),
            ).first()

            if existing_job:
                event.job_id = existing_job.id
                log.info(
                    f"Dedup: linked iCal event {uid} to existing job {existing_job.id} "
                    f"for {prop.name} on {checkout_date}"
                )
                continue

            # Use PropertyIcal settings (if set) or property defaults
            check_out_time = (property_ical.checkout_time if property_ical else None) or prop.check_out_time or "10:00"
            duration = (property_ical.duration_hours if property_ical else None) or prop.default_duration_hours or 3.0
            house_code = (property_ical.house_code if property_ical else None) or prop.house_code

            # Calculate end time: look for next booking on same day
            end_time = None
            next_booking_checkins = [e['checkin_date'] for e in events_by_checkout.get(checkout_date, []) if e['checkin_date'] and e['checkin_date'] >= checkin_date and e['checkin_date'] != checkin_date]

            if next_booking_checkins:
                # Next booking checks in today at X time — turnover ends at that check-in time
                # For now, use check_in_time from property (in a real scenario, parse from next booking)
                next_check_in = (property_ical.checkout_time if property_ical else None) or prop.check_in_time or "14:00"
                end_time = next_check_in
            else:
                # No next booking — use default duration
                end_time = _make_end_time(check_out_time, duration)

            # Extract guest metadata
            guest_metadata = _extract_guest_metadata(description)
            guest_metadata['ical_source_label'] = ical_source_label

            # Get client for GCal invite
            client = db.query(Client).filter_by(id=prop.client_id).first()
            client_name = client.name if client else "Client"

            # Build notes with reservation code, phone, and house code
            notes_parts = [f"Guest checkout. Booking: {summary}"]
            if guest_metadata.get('airbnb_reservation_code'):
                notes_parts.append(f"Res: {guest_metadata['airbnb_reservation_code']}")
            if guest_metadata.get('guest_phone_last_4'):
                notes_parts.append(f"Phone: ...{guest_metadata['guest_phone_last_4']}")
            if house_code:
                notes_parts.append(f"Code: {house_code}")
            if property_ical and property_ical.instructions:
                notes_parts.append(f"Instructions: {property_ical.instructions}")
            notes_text = " | ".join(notes_parts)

            job = Job(
                client_id=prop.client_id,
                property_id=prop.id,
                job_type="str_turnover",
                title=f"Turnover — {prop.name}",
                scheduled_date=checkout_date,
                start_time=check_out_time,
                end_time=end_time,
                address=prop.address,
                notes=notes_text,
                status="scheduled",
                ical_event_id=event.id,
                custom_fields=guest_metadata,
            )
            db.add(job)
            db.flush()

            event.job_id = job.id
            created_jobs += 1

            # Push to Google Calendar with guest metadata in description
            try:
                from integrations.google_calendar import create_event

                description_parts = [notes_text]
                if guest_metadata.get('airbnb_reservation_code'):
                    description_parts.append(f"Booking: {guest_metadata['airbnb_reservation_code']}")

                job_dict = {
                    "id": job.id,
                    "title": job.title,
                    "job_type": "str_turnover",
                    "scheduled_date": checkout_date,
                    "start_time": check_out_time,
                    "end_time": end_time,
                    "address": prop.address,
                    "notes": " | ".join(description_parts),
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
                    log.info(f"Pushed turnover to GCal: {prop.name} on {checkout_date} (event={gcal_event_id})")
            except Exception as e:
                log.warning(f"Failed to push turnover to GCal for {prop.name} on {checkout_date}: {e}")

    db.commit()

    return {
        "events_seen": seen,
        "events_created": created_events,
        "jobs_created": created_jobs,
        "skipped_host_blocks": skipped_host_blocks,
        "skipped_not_reserved": skipped_not_reserved,
    }


def sync_property(db: Session, prop: Property) -> dict:
    """
    Sync a property's iCal feeds (both legacy ical_url and PropertyIcal entries).
    Returns summary dict.
    Designed to be called from an API route or background task.
    """
    if not prop.ical_url and not prop.property_icals:
        return {"error": "No iCal URLs configured for this property"}

    total_seen = 0
    total_created_events = 0
    total_created_jobs = 0
    total_skipped_host_blocks = 0
    total_skipped_not_reserved = 0
    sources_synced = []

    # Sync legacy ical_url first if it exists
    if prop.ical_url:
        result = _sync_ical_url(db, prop, prop.ical_url, ical_source_label="legacy")
        if "error" not in result:
            total_seen += result["events_seen"]
            total_created_events += result["events_created"]
            total_created_jobs += result["jobs_created"]
            total_skipped_host_blocks += result["skipped_host_blocks"]
            total_skipped_not_reserved += result["skipped_not_reserved"]
            sources_synced.append("legacy_ical_url")

    # Sync all PropertyIcal entries
    for prop_ical in (prop.property_icals or []):
        if not prop_ical.active:
            continue
        result = _sync_ical_url(
            db, prop, prop_ical.url,
            ical_source_label=prop_ical.source or "unknown",
            property_ical=prop_ical
        )
        if "error" not in result:
            total_seen += result["events_seen"]
            total_created_events += result["events_created"]
            total_created_jobs += result["jobs_created"]
            total_skipped_host_blocks += result["skipped_host_blocks"]
            total_skipped_not_reserved += result["skipped_not_reserved"]
            sources_synced.append(prop_ical.source or "unknown")
            # Update PropertyIcal sync timestamp
            prop_ical.last_synced_at = datetime.utcnow()

    # Update property sync timestamp
    prop.ical_last_synced_at = datetime.utcnow()
    db.commit()

    return {
        "property_id": prop.id,
        "property_name": prop.name,
        "events_seen": total_seen,
        "events_created": total_created_events,
        "jobs_created": total_created_jobs,
        "skipped_host_blocks": total_skipped_host_blocks,
        "skipped_not_reserved": total_skipped_not_reserved,
        "sources_synced": sources_synced,
        "synced_at": prop.ical_last_synced_at.isoformat() if prop.ical_last_synced_at else None,
    }

