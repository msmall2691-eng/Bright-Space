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


def _build_event(job: dict, client: dict) -> dict:
    """Build a Google Calendar event dict from a job and client."""
    tz = "America/New_York"
    date = job["scheduled_date"]
    start_dt = f"{date}T{job['start_time']}:00"
    end_dt   = f"{date}T{job['end_time']}:00"

    job_type = job.get("job_type", "residential")
    type_label = {"residential": "Residential", "commercial": "Commercial", "str_turnover": "STR Turnover"}.get(job_type, "")

    description_lines = [
        f"📋 Job: {job['title']}",
        f"👤 Client: {client.get('name', '')}",
    ]
    if job.get("address"):
        description_lines.append(f"📍 {job['address']}")
    if job.get("notes"):
        description_lines.append(f"\nNotes: {job['notes']}")
    description_lines.append("\n— The Maine Cleaning Co.")

    event = {
        "summary": job["title"],
        "location": job.get("address", ""),
        "description": "\n".join(description_lines),
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

    # Add client as attendee if they have an email
    attendees = []
    if client.get("email"):
        attendees.append({"email": client["email"], "displayName": client.get("name", "")})
    if attendees:
        event["attendees"] = attendees

    return event


def create_event(job: dict, client: dict) -> str | None:
    """Create a Google Calendar event. Returns the event ID or None on failure."""
    try:
        service = _get_service()
        cal_id = _calendar_id(job.get("job_type", "residential"))
        event = _build_event(job, client)
        result = service.events().insert(
            calendarId=cal_id,
            body=event,
            sendUpdates="all",  # sends invite email to attendees
        ).execute()
        return result.get("id")
    except RuntimeError as e:
        print(f"[GCal] Not authorized: {e}")
        return None
    except HttpError as e:
        print(f"[GCal] API error creating event: {e}")
        return None


def update_event(event_id: str, job: dict, client: dict) -> bool:
    """Update an existing Google Calendar event."""
    try:
        service = _get_service()
        cal_id = _calendar_id(job.get("job_type", "residential"))
        event = _build_event(job, client)
        service.events().update(
            calendarId=cal_id,
            eventId=event_id,
            body=event,
            sendUpdates="all",
        ).execute()
        return True
    except Exception as e:
        print(f"[GCal] Error updating event: {e}")
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
