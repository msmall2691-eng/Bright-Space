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


def _load_db_token() -> str | None:
    """Read the authorized-user token JSON saved by the in-app 'Connect Google'
    flow. Stored in app_settings so it survives Railway's ephemeral filesystem."""
    try:
        from database.db import SessionLocal
        from database.models import AppSetting
        db = SessionLocal()
        try:
            row = db.query(AppSetting).filter(AppSetting.key == "google_token").first()
            return row.value if row and row.value else None
        finally:
            db.close()
    except Exception:
        return None


def _save_db_token(token_json: str) -> None:
    try:
        from database.db import SessionLocal
        from database.models import AppSetting
        db = SessionLocal()
        try:
            row = db.query(AppSetting).filter(AppSetting.key == "google_token").first()
            if row:
                row.value = token_json
            else:
                db.add(AppSetting(key="google_token", value=token_json))
            db.commit()
        finally:
            db.close()
    except Exception as e:
        print(f"[GCal] Could not persist refreshed token to DB: {e}")


# Which user_google_accounts row drove the last _get_service() call (None =
# legacy shared token). Callers can read this to stamp sync provenance.
_ACTIVE_ACCOUNT_ID: int | None = None

# Sentinel for _get_service: "no owner specified — prefer the newest connected
# account, then the legacy chain". Distinct from an explicit None, which means
# "this event belongs to the LEGACY shared token; don't let a member's account
# hijack the mutation" (Codex P1 on #265: update/cancel paths were querying
# whichever account connected most recently, where the event doesn't exist).
_PREFER_CONNECTED = object()


def active_account_id() -> int | None:
    return _ACTIVE_ACCOUNT_ID


def _account_service(account_id: int | None = None):
    """Calendar service from a member's connected Google account (phase C).

    account_id None  -> the most recently connected account with the calendar
                        channel enabled (used for NEW events).
    account_id int   -> exactly that account row — the recorded owner of an
                        existing event — regardless of its sync toggle.
    Returns None when there is no usable account, so the caller falls through
    to the legacy shared token (kept as a fallback per the rollout plan)."""
    global _ACTIVE_ACCOUNT_ID
    try:
        from database.db import SessionLocal
        from database.models import UserGoogleAccount
        from integrations.google_accounts import (
            AccountCredentialsError, account_credentials, calendar_account,
        )
        db = SessionLocal()
        try:
            if account_id is not None:
                acct = db.query(UserGoogleAccount).filter(UserGoogleAccount.id == account_id).first()
            else:
                acct = calendar_account(db)
            if not acct:
                return None
            try:
                creds = account_credentials(db, acct)
            except AccountCredentialsError as e:
                print(f"[GCal] connected account unusable, falling back to shared token: {e}")
                return None
            _ACTIVE_ACCOUNT_ID = acct.id
            return build("calendar", "v3", credentials=creds)
        finally:
            db.close()
    except Exception as e:
        print(f"[GCal] per-user account lookup failed (falling back): {e}")
        return None


def _get_service(account_id=_PREFER_CONNECTED):
    """Build and return an authenticated Google Calendar service.

    account_id semantics:
      _PREFER_CONNECTED (default) — newest connected member account with the
        calendar channel on, then the legacy shared token. For NEW events and
        read-only calls.
      <int> — the recorded owner (jobs.gcal_account_id) of an existing event;
        falls back to the legacy chain only if that grant is unusable.
      None — the event predates per-user accounts (gcal_account_id NULL):
        go straight to the legacy shared token.
    """
    import base64, json as _json

    global _ACTIVE_ACCOUNT_ID
    _ACTIVE_ACCOUNT_ID = None

    if account_id is not None:
        svc = _account_service(None if account_id is _PREFER_CONNECTED else account_id)
        if svc is not None:
            return svc

    base = Path(__file__).parent.parent
    token_path = base / os.getenv("GOOGLE_TOKEN_FILE", "google_token.json")

    creds = None
    from_db = False

    # 1. DB token (self-serve Connect Google)
    db_token = _load_db_token()
    if db_token:
        try:
            creds = Credentials.from_authorized_user_info(_json.loads(db_token), SCOPES)
            from_db = True
        except Exception:
            creds = None

    # 2. Env / file token (manual path) — also seed the file from base64 env.
    if creds is None:
        token_b64 = os.getenv("GOOGLE_TOKEN_B64")
        if token_b64 and not token_path.exists():
            token_path.write_bytes(base64.b64decode(token_b64))
        if token_path.exists():
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    # Client secret file (used for token refresh) from base64 env if present.
    creds_b64 = os.getenv("GOOGLE_CREDENTIALS_B64")
    creds_path = base / os.getenv("GOOGLE_CREDENTIALS_FILE", "google_credentials.json")
    if creds_b64 and not creds_path.exists():
        creds_path.write_bytes(base64.b64decode(creds_b64))

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            if from_db:
                _save_db_token(creds.to_json())
            else:
                with open(token_path, "w") as f:
                    f.write(creds.to_json())
        else:
            raise RuntimeError(
                "Google Calendar not authorized. Connect your Google account in "
                "Settings → Integrations, or set GOOGLE_TOKEN_B64."
            )

    return build("calendar", "v3", credentials=creds)


def is_configured() -> bool:
    """Best-effort check that Google Calendar credentials are present.

    Lets callers distinguish "Google isn't connected at all" from "connected
    but the API call failed", so the UI can tell the operator whether the
    event actually landed on Google (the source of truth) or not.
    """
    try:
        from database.db import SessionLocal
        from integrations.google_accounts import calendar_account
        db = SessionLocal()
        try:
            if calendar_account(db):
                return True
        finally:
            db.close()
    except Exception:
        pass
    if _load_db_token():
        return True
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
    try:
        from integrations.google_oauth import is_oauth_available
        oauth_available = is_oauth_available()
    except Exception:
        oauth_available = False
    if not is_configured():
        return {
            "connected": False,
            "reason": "no_credentials",
            "detail": "Google account not connected. Click Connect Google to "
                      "link your work account, or set GOOGLE_TOKEN_B64 on the server.",
            "calendars": [],
            "write_targets": write_targets,
            "oauth_available": oauth_available,
        }
    try:
        service = _get_service()
        cal_list = service.calendarList().list(maxResults=100).execute()
        items = cal_list.get("items", [])
        calendars = [
            {"id": c.get("id"), "summary": c.get("summary"), "primary": bool(c.get("primary"))}
            for c in items
        ]
        # The primary calendar id IS the connected Google account's address — the
        # single most useful fact for spotting "wrong account / wrong calendar".
        account_email = next((c.get("id") for c in items if c.get("primary")), None)
        cal_ids = {c.get("id") for c in items}
        # Validate EVERY per-job-type write target (residential, commercial, and
        # — importantly for Airbnb turnovers — str_turnover). "primary" always
        # resolves; a specific GCAL_*_ID might point at a calendar this account
        # can't see, which is why those events never appear.
        write_targets_ok = {
            jt: (cal == "primary" or cal in cal_ids)
            for jt, cal in write_targets.items()
        }
        write_target_ok = all(write_targets_ok.values())
        return {
            "connected": True,
            "reason": None,
            "detail": f"Connected as {account_email}." if account_email else "Google Calendar is connected.",
            "account_email": account_email,
            "calendars": calendars,
            "write_targets": write_targets,
            "write_targets_ok": write_targets_ok,
            "write_target_ok": write_target_ok,
            "oauth_available": oauth_available,
        }
    except RuntimeError:
        return {
            "connected": False, "reason": "not_authorized",
            "detail": "Google account not connected. Click Connect Google to link "
                      "your work account, or set GOOGLE_TOKEN_B64 on the server.",
            "calendars": [], "write_targets": write_targets,
            "oauth_available": oauth_available,
        }
    except Exception as e:
        print(f"[GCal] connection_status check failed: {e}")
        return {
            "connected": False, "reason": "error",
            "detail": "Couldn't verify the Google Calendar connection.",
            "calendars": [], "write_targets": write_targets,
            "oauth_available": oauth_available,
        }


def _event_to_dict(ev: dict, calendar_id: str) -> dict:
    """Flatten a raw Google event into the shape the client profile renders."""
    start = ev.get("start", {}) or {}
    end = ev.get("end", {}) or {}
    ext = (ev.get("extendedProperties", {}) or {}).get("private", {}) or {}
    return {
        "id": ev.get("id"),
        "calendar_id": calendar_id,
        "title": ev.get("summary") or "(no title)",
        "location": ev.get("location"),
        "description": ev.get("description"),
        "html_link": ev.get("htmlLink"),
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        "all_day": "date" in start and "dateTime" not in start,
        "status": ev.get("status"),
        "attendees": [
            {"email": a.get("email"), "responseStatus": a.get("responseStatus")}
            for a in (ev.get("attendees") or [])
        ],
        "job_id": ext.get("brightbase_job_id"),
        "job_type": ext.get("brightbase_job_type"),
    }


def list_events_for_client(
    client_id: int | None,
    client_email: str | None,
    time_min_iso: str,
    time_max_iso: str,
) -> list[dict]:
    """Live Google Calendar events linked to a client — the Twenty-style
    "events connected by email" timeline.

    An event matches when the client is an attendee (by email) OR the event
    carries our brightbase_client_id extended property. Searches every
    configured calendar and de-dupes by event id. Returns [] when Google isn't
    connected (the caller surfaces that separately via connection_status)."""
    service = _get_service()  # raises RuntimeError when not connected
    cal_ids = {
        _calendar_id("residential"),
        _calendar_id("commercial"),
        _calendar_id("str_turnover"),
    }
    email_l = (client_email or "").lower().strip()
    seen: dict[str, dict] = {}
    for cal_id in cal_ids:
        page_token = None
        try:
            while True:
                resp = service.events().list(
                    calendarId=cal_id,
                    timeMin=time_min_iso,
                    timeMax=time_max_iso,
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=250,
                    pageToken=page_token,
                ).execute()
                for ev in resp.get("items", []):
                    ext = (ev.get("extendedProperties", {}) or {}).get("private", {}) or {}
                    matched = bool(client_id) and str(ext.get("brightbase_client_id")) == str(client_id)
                    if not matched and email_l:
                        for a in ev.get("attendees", []) or []:
                            if (a.get("email") or "").lower() == email_l:
                                matched = True
                                break
                    if matched and ev.get("id"):
                        seen[ev["id"]] = _event_to_dict(ev, cal_id)
                page_token = resp.get("nextPageToken")
                if not page_token:
                    break
        except HttpError as e:
            print(f"[GCal] list events failed for calendar {cal_id}: {e}")
    return sorted(seen.values(), key=lambda e: e.get("start") or "")


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

    def _hm(t):
        """Normalize a time to 'HH:MM' whether it's a string ('10:00' /
        '10:00:00') or a datetime.time (what the ORM returns from a Time column).
        Without this, a time object str()'d into the template produced an invalid
        '...T10:00:00:00' and Google rejected the event."""
        if t is None:
            return "00:00"
        if hasattr(t, "strftime"):
            return t.strftime("%H:%M")
        return str(t)[:5]

    date = job["scheduled_date"]
    start_dt = f"{date}T{_hm(job['start_time'])}:00"
    end_dt   = f"{date}T{_hm(job['end_time'])}:00"

    job_type = job.get("job_type", "residential")
    type_label = {"residential": "Residential", "commercial": "Commercial", "str_turnover": "STR Turnover"}.get(job_type, "")

    if include_attendees:
        # Customer-facing event — the client is an attendee and sees this on
        # their own calendar, so keep it clean: NO gate codes, access notes,
        # crew, or internal notes. Just what the customer should know.
        description_lines = [f"{type_label} cleaning" if type_label else "Cleaning"]
        if job.get("address"):
            description_lines.append(f"Address: {job['address']}")
        description_lines.append("\nYour upcoming cleaning with The Maine Cleaning Co.")
        description_lines.append("Questions or need to reschedule? Just reply to this invitation.")
    else:
        # Internal event (your calendar / crew) — full on-site detail.
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


def update_event(event_id: str, job: dict, client: dict, send_invite: bool = False, crew_emails: list[str] | None = None, property_data: dict | None = None, owner_account_id: int | None = None) -> bool:
    """Update an existing Google Calendar event. owner_account_id is the
    job's recorded gcal_account_id — mutations must hit the calendar the
    event actually lives on (None = the legacy shared token)."""
    try:
        service = _get_service(owner_account_id)
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


def invite_client_to_event(event_id: str, job_type: str, client_email: str, client_name: str = "", owner_account_id: int | None = None) -> bool:
    """Add a client as attendee to an existing GCal event and send them the invite.

    This is the "I'm ready — send it to the client" action.
    """
    if not client_email or not client_email.strip():
        print("[GCal] Cannot invite: no client email provided")
        return False
    try:
        service = _get_service(owner_account_id)
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


def delete_event(event_id: str, job_type: str = "residential", owner_account_id: int | None = None) -> bool:
    """Delete a Google Calendar event from the calendar it lives on."""
    try:
        service = _get_service(owner_account_id)
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


def get_event(event_id: str, job_type: str = "residential", owner_account_id: int | None = None) -> dict | None:
    """Fetch a single GCal event by id. Returns:
    - the event dict (with whatever shape Google returns) if found
    - None if the event was deleted (404)
    - raises on other errors so the caller can decide what to do

    Used by sync_gcal_cancellations() to detect events that have been
    deleted from Google Calendar — they disappear from events.list,
    so a per-event check is the only reliable signal.
    """
    from googleapiclient.errors import HttpError
    service = _get_service(owner_account_id)
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
