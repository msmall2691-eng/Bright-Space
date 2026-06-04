"""
Google Calendar integration.
Creates/updates/deletes events when jobs are created or changed.
Adds client as a guest so they receive an invite + automatic reminders.
"""

import os
from pathlib import Path
from datetime import datetime

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/calendar"]

# Color IDs per job type (Google Calendar color system)
JOB_TYPE_COLORS = {
    "residential": "9",   # Blueberry
    "commercial":  "10",  # Basil (green)
    "str_turnover": "6",  # Tangerine (orange)
}

# Calendar IDs per job type (set in .env)
def _calendar_id(job_type: str) -> str:
    mapping = {
        "residential": os.getenv("GCAL_RESIDENTIAL_ID", "primary"),
        "commercial":  os.getenv("GCAL_COMMERCIAL_ID",  "primary"),
        "str_turnover": os.getenv("GCAL_STR_ID",        "primary"),
    }
    return mapping.get(job_type, "primary")


def _get_service():
    """Build and return an authenticated Google Calendar service."""
    import base64, tempfile, json as _json

    base = Path(__file__).parent.parent
    token_path = base / os.getenv("GOOGLE_TOKEN_FILE", "google_token.json")

    # Support base64-encoded credentials stored in env vars (for Railway/cloud)
    token_b64 = os.getenv("GOOGLE_TOKEN_B64")
    if token_b64 and not token_path.exists():
        token_path.write_bytes(base64.b64decode(token_b64))

    creds_b64 = os.getenv("GOOGLE_CREDENTIALS_B64")
    creds_path = base / os.getenv("GOOGLE_CREDENTIALS_FILE", "google_credentials.json")
    if creds_b64 and not creds_path.exists():
        creds_path.write_bytes(base64.b64decode(creds_b64))

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(token_path, "w") as f:
                f.write(creds.to_json())
        else:
            raise RuntimeError(
                "Google Calendar not authorized. Set GOOGLE_TOKEN_B64 env var or run: python auth_google.py"
            )

    return build("calendar", "v3", credentials=creds)


def is_configured() -> bool:
    """Best-effort check that Google Calendar credentials are present.

    Lets callers distinguish "Google isn't connected at all" from "connected
    but the API call failed", so the UI can tell the operator whether the
    event actually landed on Google (the source of truth) or not.
    """
    if os.getenv("GOOGLE_TOKEN_B64"):
        return True
    base = Path(__file__).parent.parent
    token_path = base / os.getenv("GOOGLE_TOKEN_FILE", "google_token.json")
    return token_path.exists()


def connection_status() -> dict:
    """Live diagnostic of the Google Calendar connection.

    Returns a dict the UI can render directly:
      - connected: bool — did a real API call succeed?
      - reason: machine code when not connected (no_credentials / not_authorized / error)
      - detail: human-readable explanation / next step
      - calendars: list of calendars this token can see (id, summary, primary)
      - write_targets: which calendar id the app writes to per job type, so the
        operator can confirm it matches the calendar they're viewing/embedding.

    This exists because a missing/expired token used to fail silently — the app
    would report "connected" while every event write quietly returned None.
    """
    write_targets = {
        "residential": _calendar_id("residential"),
        "commercial":  _calendar_id("commercial"),
        "str_turnover": _calendar_id("str_turnover"),
    }
    if not is_configured():
        return {
            "connected": False,
            "reason": "no_credentials",
            "detail": "No Google token found on the server. Set GOOGLE_TOKEN_B64 "
                      "(and GOOGLE_CREDENTIALS_B64) — generate it by running "
                      "auth_google.py locally, then base64-encode google_token.json.",
            "calendars": [],
            "write_targets": write_targets,
        }
    try:
        service = _get_service()
        cal_list = service.calendarList().list(maxResults=100).execute()
        calendars = [
            {"id": c.get("id"), "summary": c.get("summary"), "primary": bool(c.get("primary"))}
            for c in cal_list.get("items", [])
        ]
        return {
            "connected": True,
            "reason": None,
            "detail": "Google Calendar is connected.",
            "calendars": calendars,
            "write_targets": write_targets,
        }
    except RuntimeError as e:
        return {
            "connected": False, "reason": "not_authorized", "detail": str(e),
            "calendars": [], "write_targets": write_targets,
        }
    except Exception as e:
        return {
            "connected": False, "reason": "error", "detail": str(e),
            "calendars": [], "write_targets": write_targets,
        }


def _build_event(job: dict, client: dict, include_attendees: bool = False, crew_emails: list[str] | None = None, property_data: dict | None = None) -> dict:
    """Build a Google Calendar event dict from a job and client.

    include_attendees: When False (default), creates the event on YOUR calendar only.
                       When True, adds the client as an attendee so they get an invite.
    crew_emails: List of cleaner emails to add as attendees so they see event on their phones.
    property_data: Optional dict with property metadata (timezone, house_code, access_notes, etc.)
                   Used to enrich event description with on-site info.
    """
    # Use property timezone if available, otherwise default to America/New_York
    tz = (property_data or {}).get("timezone") or "America/New_York"
    date = job["scheduled_date"]
    start_dt = f"{date}T{job['start_time']}:00"
    end_dt   = f"{date}T{job['end_time']}:00"

    job_type = job.get("job_type", "residential")
    type_label = {"residential": "Residential", "commercial": "Commercial", "str_turnover": "STR Turnover"}.get(job_type, "")

    description_lines = [
        f"Job: {job['title']}",
        f"Type: {type_label}" if type_label else None,
        f"Client: {client.get('name', '')}",
    ]
    if job.get("address"):
        description_lines.append(f"Address: {job['address']}")

    # Property-level on-site info
    if property_data:
        if property_data.get("house_code"):
            description_lines.append(f"Access Code: {property_data['house_code']}")
        if property_data.get("access_notes"):
            description_lines.append(f"Access: {property_data['access_notes']}")
        if property_data.get("parking_notes"):
            description_lines.append(f"Parking: {property_data['parking_notes']}")
        if property_data.get("site_contact_name") and property_data.get("site_contact_phone"):
            description_lines.append(
                f"Site contact: {property_data['site_contact_name']} ({property_data['site_contact_phone']})"
            )

    # Crew assignment
    if crew_emails:
        description_lines.append(f"Crew: {len(crew_emails)} assigned")

    if job.get("notes"):
        description_lines.append(f"\nNotes: {job['notes']}")
    description_lines.append("\n— The Maine Cleaning Co.")

    # Filter None entries
    description = "\n".join(line for line in description_lines if line)

    event = {
        "summary": job["title"],
        "location": job.get("address", ""),
        "description": description,
        "start": {"dateTime": start_dt, "timeZone": tz},
        "end":   {"dateTime": end_dt,   "timeZone": tz},
        "colorId": JOB_TYPE_COLORS.get(job_type, "1"),
        "reminders": {
            "useDefault": False,
            "overrides": [
                {"method": "email",  "minutes": 24 * 60},  # 24hrs before
                {"method": "popup",  "minutes": 60},        # 1hr before
            ],
        },
    }

    # Build attendee list: client (if invited) + crew members
    attendees = []
    if include_attendees and client.get("email"):
        attendees.append({"email": client["email"], "displayName": client.get("name", "")})
    if crew_emails:
        for email in crew_emails:
            if email and email.strip():
                attendees.append({"email": email.strip(), "responseStatus": "accepted"})
    if attendees:
        event["attendees"] = attendees

    # Store BrightBase metadata as extendedProperties so the sync engine
    # can identify which client/property this event belongs to.
    # These are invisible in the GCal UI but queryable via API.
    ext_private = {"brightbase_source": "true"}
    if job.get("id"):
        ext_private["brightbase_job_id"] = str(job["id"])
    if client.get("id"):
        ext_private["brightbase_client_id"] = str(client["id"])
    if job.get("property_id"):
        ext_private["brightbase_property_id"] = str(job["property_id"])
    if job.get("job_type"):
        ext_private["brightbase_job_type"] = job["job_type"]
    event["extendedProperties"] = {"private": ext_private}

    return event


def create_event(job: dict, client: dict, send_invite: bool = False, crew_emails: list[str] | None = None, property_data: dict | None = None) -> str | None:
    """Create a Google Calendar event. Returns the event ID or None on failure.

    send_invite: When False (default), event goes on your calendar silently.
                 When True, client is added as attendee and gets an invite email.
    crew_emails: List of cleaner emails to add as attendees (gets event on their phone).
    property_data: Optional property metadata for richer description (timezone, house_code, access_notes, etc.)
    """
    try:
        service = _get_service()
        cal_id = _calendar_id(job.get("job_type", "residential"))
        event = _build_event(
            job, client,
            include_attendees=send_invite,
            crew_emails=crew_emails,
            property_data=property_data,
        )
        # Send updates to crew even if not officially "inviting" the client
        send_param = "all" if (send_invite or crew_emails) else "none"
        result = service.events().insert(
            calendarId=cal_id,
            body=event,
            sendUpdates=send_param,
        ).execute()
        return result.get("id")
    except RuntimeError as e:
        print(f"[GCal] Not authorized: {e}")
        return None
    except HttpError as e:
        print(f"[GCal] API error creating event: {e}")
        return None


def update_event(event_id: str, job: dict, client: dict, send_invite: bool = False, crew_emails: list[str] | None = None, property_data: dict | None = None) -> bool:
    """Update an existing Google Calendar event."""
    try:
        service = _get_service()
        cal_id = _calendar_id(job.get("job_type", "residential"))
        event = _build_event(
            job, client,
            include_attendees=send_invite,
            crew_emails=crew_emails,
            property_data=property_data,
        )
        send_param = "all" if (send_invite or crew_emails) else "none"
        service.events().update(
            calendarId=cal_id,
            eventId=event_id,
            body=event,
            sendUpdates=send_param,
        ).execute()
        return True
    except Exception as e:
        print(f"[GCal] Error updating event: {e}")
        return False


def invite_client_to_event(event_id: str, job_type: str, client_email: str, client_name: str = "") -> bool:
    """Add a client as attendee to an existing GCal event and send them the invite.

    This is the "I'm ready — send it to the client" action.
    """
    if not client_email or not client_email.strip():
        print("[GCal] Cannot invite: no client email provided")
        return False
    try:
        service = _get_service()
        cal_id = _calendar_id(job_type)
        # Fetch current event to preserve existing data
        event = service.events().get(calendarId=cal_id, eventId=event_id).execute()
        # Add client to attendees (avoid duplicates)
        attendees = event.get("attendees", [])
        already_invited = any(a.get("email", "").lower() == client_email.lower() for a in attendees)
        if already_invited:
            return True  # Already invited, no need to send again
        attendees.append({"email": client_email, "displayName": client_name})
        event["attendees"] = attendees
        service.events().update(
            calendarId=cal_id,
            eventId=event_id,
            body=event,
            sendUpdates="all",  # THIS is what sends the invite email
        ).execute()
        return True
    except Exception as e:
        print(f"[GCal] Error inviting client to event: {e}")
        return False


def delete_event(event_id: str, job_type: str = "residential") -> bool:
    """Delete a Google Calendar event."""
    try:
        service = _get_service()
        cal_id = _calendar_id(job_type)
        service.events().delete(
            calendarId=cal_id,
            eventId=event_id,
            sendUpdates="all",
        ).execute()
        return True
    except Exception as e:
        print(f"[GCal] Error deleting event: {e}")
        return False


def get_event(event_id: str, job_type: str = "residential") -> dict | None:
    """Fetch a single GCal event by id. Returns:
    - the event dict (with whatever shape Google returns) if found
    - None if the event was deleted (404)
    - raises on other errors so the caller can decide what to do

    Used by sync_gcal_cancellations() to detect events that have been
    deleted from Google Calendar — they disappear from events.list,
    so a per-event check is the only reliable signal.
    """
    from googleapiclient.errors import HttpError
    service = _get_service()
    cal_id = _calendar_id(job_type)
    try:
        return service.events().get(calendarId=cal_id, eventId=event_id).execute()
    except HttpError as e:
        if getattr(e, "resp", None) is not None and e.resp.status == 404:
            return None
        if getattr(e, "resp", None) is not None and e.resp.status == 410:
            # 410 Gone = event was permanently deleted. Treat same as 404.
            return None
        raise
