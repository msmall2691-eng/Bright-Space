"""
Google Calendar Sync Engine — polls GCal and links events to BrightBase clients.

This is the core of the "GCal as source of truth" model. It works like Copper CRM:
  1. Poll your Google Calendars for events
  2. Match each event to a BrightBase client using three methods:
     a. extendedProperties.private.client_id (exact, for events BrightBase created)
     b. Attendee email matching (proven pattern from Copper/HubSpot/Twenty)
     c. Location/address matching (fallback for events with no attendees)
  3. Create or update Job records in BrightBase linked to the matched client
  4. Detect changes (reschedules, cancellations) and update accordingly

You work in Google Calendar. BrightBase just watches and adds the business layer.
"""

import os
import logging
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from database.models import Job, Client, Property

log = logging.getLogger(__name__)


def _s(val) -> str:
    """Safely convert a value to a stripped string. Handles None from GCal API."""
    return str(val).strip() if val else ""


# Keys used in extendedProperties.private for BrightBase-created events
EP_CLIENT_ID = "brightbase_client_id"
EP_PROPERTY_ID = "brightbase_property_id"
EP_JOB_ID = "brightbase_job_id"
EP_SOURCE = "brightbase_source"


def _normalize_address(addr: str) -> str:
    """Normalize an address for fuzzy comparison.
    Handles common variations: St/Street, Ave/Avenue, trailing commas, etc.
    """
    if not addr:
        return ""
    a = addr.lower().strip().rstrip(",")
    # Common abbreviation expansions
    replacements = {
        " street": " st", " avenue": " ave", " boulevard": " blvd",
        " drive": " dr", " lane": " ln", " road": " rd", " court": " ct",
        " place": " pl", " circle": " cir", " terrace": " ter",
        " highway": " hwy", " apartment": " apt", " suite": " ste",
    }
    for full, abbr in replacements.items():
        a = a.replace(full, abbr)
    # Remove extra whitespace, commas, periods
    a = " ".join(a.replace(",", " ").replace(".", "").split())
    return a


def _addresses_match(addr1: str, addr2: str) -> bool:
    """Check if two addresses refer to the same location."""
    n1 = _normalize_address(addr1)
    n2 = _normalize_address(addr2)
    if not n1 or not n2:
        return False
    # Exact match after normalization
    if n1 == n2:
        return True
    # Check if one starts with the other (handles "123 Main St" vs "123 Main St, Portland, ME 04101")
    # Using startswith avoids false positives like "123" matching "1123"
    if n1.startswith(n2) or n2.startswith(n1):
        return True
    return False


def _match_by_extended_properties(event: dict, db: Session) -> dict | None:
    """Try to match via BrightBase's extendedProperties (exact match)."""
    ext = event.get("extendedProperties", {}).get("private", {})
    client_id = ext.get(EP_CLIENT_ID)
    if client_id:
        try:
            client = db.query(Client).filter(Client.id == int(client_id)).first()
        except (ValueError, TypeError):
            return None
        if client:
            prop_id = None
            try:
                prop_id = int(ext[EP_PROPERTY_ID]) if ext.get(EP_PROPERTY_ID) else None
            except (ValueError, TypeError):
                pass
            return {
                "client": client,
                "property_id": prop_id,
                "method": "extendedProperties",
            }
    return None


def _match_by_attendee_email(event: dict, db: Session) -> dict | None:
    """Try to match via attendee email — the Copper/HubSpot/Twenty pattern."""
    attendees = event.get("attendees", [])
    for attendee in attendees:
        email = _s(attendee.get("email")).lower()
        if not email:
            continue
        # Skip the calendar owner (organizer) — we want the client, not ourselves
        if attendee.get("self"):
            continue
        client = db.query(Client).filter(
            Client.email.ilike(email)
        ).first()
        if client:
            return {"client": client, "property_id": None, "method": "attendee_email"}
    return None


def _match_by_address(event: dict, db: Session) -> dict | None:
    """Try to match via location/address — fallback for events with no attendees."""
    location = _s(event.get("location"))
    if not location:
        return None

    # Check properties first (more specific — an address ties to a specific property)
    properties = db.query(Property).filter(Property.active == True).all()
    for prop in properties:
        prop_addr = prop.address or ""
        if prop.city:
            prop_addr += f", {prop.city}"
        if prop.state:
            prop_addr += f", {prop.state}"
        if _addresses_match(location, prop_addr):
            client = db.query(Client).filter(Client.id == prop.client_id).first()
            if client:
                return {"client": client, "property_id": prop.id, "method": "address_property"}

    # Then check client addresses
    clients = db.query(Client).filter(Client.address.isnot(None), Client.address != "").all()
    for client in clients:
        client_addr = client.address or ""
        if client.city:
            client_addr += f", {client.city}"
        if client.state:
            client_addr += f", {client.state}"
        if _addresses_match(location, client_addr):
            return {"client": client, "property_id": None, "method": "address_client"}

    return None


def _parse_event_datetime(dt_obj: dict | None) -> tuple[str, str] | None:
    """Parse a GCal start/end object into (YYYY-MM-DD, HH:MM)."""
    if not dt_obj:
        return None
    if "dateTime" in dt_obj:
        dt = datetime.fromisoformat(dt_obj["dateTime"].replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")
    if "date" in dt_obj:
        return dt_obj["date"], None
    return None


def _infer_job_type(event: dict, match: dict) -> str:
    """Infer job type from event context."""
    ext = event.get("extendedProperties", {}).get("private", {})
    if ext.get("brightbase_job_type"):
        return ext["brightbase_job_type"]
    if match.get("property_id"):
        return "str_turnover"
    title = event.get("summary", "").lower()
    if "commercial" in title:
        return "commercial"
    if "turnover" in title or "str turnover" in title or "airbnb" in title:
        return "str_turnover"
    return "residential"


def sync_calendar(db: Session, calendar_ids: list[str] | None = None) -> dict:
    """
    Poll Google Calendar(s) and sync events to BrightBase jobs.

    For each event found:
    1. Skip if it's already linked to a Job (via gcal_event_id)
    2. Try to match to a client (extendedProperties → email → address)
    3. Create a Job record linked to the matched client
    4. For already-linked jobs, detect GCal changes and update

    Returns a summary of what happened.
    """
    try:
        from integrations.google_calendar import _get_service
    except ImportError as e:
        return {"error": f"GCal not configured: {e}"}

    try:
        service = _get_service()
    except RuntimeError as e:
        return {"error": f"GCal auth failed: {e}"}

    # Default to all configured business calendars
    if not calendar_ids:
        calendar_ids = list(set(filter(None, [
            os.getenv("GCAL_RESIDENTIAL_ID", "primary"),
            os.getenv("GCAL_COMMERCIAL_ID"),
            os.getenv("GCAL_STR_ID"),
        ])))
        if not calendar_ids:
            calendar_ids = ["primary"]

    # Time range: 30 days back, 90 days forward
    now = datetime.utcnow()
    time_min = (now - timedelta(days=30)).isoformat() + "Z"
    time_max = (now + timedelta(days=90)).isoformat() + "Z"

    results = {
        "calendars_synced": 0,
        "events_scanned": 0,
        "jobs_created": 0,
        "jobs_updated": 0,
        "jobs_cancelled": 0,
        "matched_by": {"extendedProperties": 0, "attendee_email": 0, "address_property": 0, "address_client": 0},
        "unmatched": 0,
        "errors": [],
    }

    for cal_id in calendar_ids:
        if not cal_id:
            continue
        try:
            events_result = service.events().list(
                calendarId=cal_id,
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime",
                maxResults=500,
            ).execute()
        except Exception as e:
            results["errors"].append({"calendar": cal_id, "error": str(e)})
            continue

        results["calendars_synced"] += 1
        events = events_result.get("items", [])

        for event in events:
            results["events_scanned"] += 1
            gcal_id = event.get("id")
            if not gcal_id:
                continue

            # Check if this event is already linked to a job
            existing_job = db.query(Job).filter(Job.gcal_event_id == gcal_id).first()

            if existing_job:
                # Event already linked — check for changes from GCal
                changed = False

                # Detect cancellation
                if event.get("status") == "cancelled":
                    if existing_job.status != "cancelled":
                        existing_job.status = "cancelled"
                        results["jobs_cancelled"] += 1
                    continue

                # Sync title
                gcal_title = _s(event.get("summary"))
                if gcal_title and gcal_title != existing_job.title:
                    existing_job.title = gcal_title
                    changed = True

                # Sync date/time
                start = event.get("start", {})
                end = event.get("end", {})
                parsed_start = _parse_event_datetime(start)
                parsed_end = _parse_event_datetime(end)
                if parsed_start:
                    new_date, new_time = parsed_start
                    if new_date != existing_job.scheduled_date:
                        existing_job.scheduled_date = new_date
                        changed = True
                    if new_time and new_time != existing_job.start_time:
                        existing_job.start_time = new_time
                        changed = True
                if parsed_end:
                    _, end_time = parsed_end
                    if end_time and end_time != existing_job.end_time:
                        existing_job.end_time = end_time
                        changed = True

                # Sync location
                gcal_location = _s(event.get("location"))
                if gcal_location and gcal_location != (existing_job.address or ""):
                    existing_job.address = gcal_location
                    changed = True

                if changed:
                    results["jobs_updated"] += 1
                continue

            # Skip cancelled events that we don't have a job for
            if event.get("status") == "cancelled":
                continue

            # Skip all-day events without times (likely personal/blocks)
            start_obj = event.get("start", {})
            if "date" in start_obj and "dateTime" not in start_obj:
                continue

            # Parse event data
            parsed_start = _parse_event_datetime(start_obj)
            parsed_end = _parse_event_datetime(event.get("end", {}))
            if not parsed_start:
                continue
            sched_date, start_time = parsed_start
            end_time = parsed_end[1] if parsed_end else None

            # Try to match to a client (3-tier matching)
            match = (
                _match_by_extended_properties(event, db)
                or _match_by_attendee_email(event, db)
                or _match_by_address(event, db)
            )

            if not match:
                results["unmatched"] += 1
                continue

            results["matched_by"][match["method"]] += 1
            client = match["client"]
            job_type = _infer_job_type(event, match)

            # Create the job
            job = Job(
                client_id=client.id,
                property_id=match.get("property_id"),
                job_type=job_type,
                title=event.get("summary", "Cleaning"),
                scheduled_date=sched_date,
                start_time=start_time or "09:00",
                end_time=end_time or "12:00",
                address=event.get("location", client.address or ""),
                gcal_event_id=gcal_id,
                calendar_invite_sent=bool(event.get("attendees")),
                status="scheduled",
                notes=_s(event.get("description")),
            )
            db.add(job)
            results["jobs_created"] += 1

    db.commit()

    total = results["jobs_created"] + results["jobs_updated"] + results["jobs_cancelled"]
    results["message"] = (
        f"Synced {results['events_scanned']} events from {results['calendars_synced']} calendar(s). "
        f"Created {results['jobs_created']}, updated {results['jobs_updated']}, "
        f"cancelled {results['jobs_cancelled']}. "
        f"{results['unmatched']} unmatched."
    )
    return results
