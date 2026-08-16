"""
Google Calendar Sync Engine — polls GCal and links events to BrightBase clients.

This works like Copper CRM, with one correction (scheduling-invariants Rule 0
/ R2 — Google Calendar is a read-only projection, never a peer that writes
canonical state):
  1. Poll your Google Calendars for events
  2. Match each event to a BrightBase client using three methods:
     a. extendedProperties.private.client_id (exact, for events BrightBase created)
     b. Attendee email matching (proven pattern from Copper/HubSpot/Twenty)
     c. Location/address matching (fallback for events with no attendees)
  3. A matched event with no existing linked Job is NOT created directly —
     it's recorded as a pending ProposedAction (kind="create_job_from_gcal",
     services/proposals.py), the same inbox pattern iCal/Airbnb turnover feeds
     use (raw capture, then human promotion). A human approves it on the Ops
     board to create the real Job (through create_job — the same write path
     JobCreateModal.jsx uses) or dismisses it to ignore the event.
  4. For already-linked jobs (found via Job.gcal_event_id), detect changes
     (reschedules, cancellations) and update accordingly — untouched by the
     above; that's not the creation path.

You work in Google Calendar. BrightBase just watches and adds the business layer.
"""

import os
import logging
from datetime import datetime, timedelta, timezone, date, time
from zoneinfo import ZoneInfo
from sqlalchemy.orm import Session
from database.models import Job, Client, Property, ProposedAction
from services.proposals import create_proposal
from config import env_flag

log = logging.getLogger(__name__)

# Human-readable phrasing for each 3-tier match method, used in the proposal
# detail shown on the Ops board's review queue.
_MATCH_LABELS = {
    "extendedProperties": "a BrightBase-tagged event",
    "attendee_email": "the guest's email address",
    "address_property": "the property address",
    "address_client": "the client's address",
}

# Business wall-clock timezone. GCal hands back an *instant* — sometimes as UTC
# ("…Z"), sometimes with an explicit offset. Jobs are scheduled and displayed in
# the business's local time, so we extract the wall-clock value in THIS zone.
# This must match the rehydrate endpoint (modules/scheduling/router.py, which
# does `astimezone(ZoneInfo("America/New_York"))`); if the two disagree, one
# writes 09:00 and the other reads 13:00 from the same 13:00Z event and the sync
# churns the time on every poll. Overridable for non-Eastern operators.
BUSINESS_TZ = ZoneInfo(os.getenv("BUSINESS_TIMEZONE", "America/New_York"))


def _s(val) -> str:
    """Safely convert a value to a stripped string. Handles None from GCal API."""
    return str(val).strip() if val else ""


def calendar_source_of_truth(db: Session) -> str:
    """Who wins when a BrightBase-owned event is edited on both sides.

    'brightbase' (default): Job/Visit is the system of record for the work —
    a reschedule made directly in Google is SURFACED (drift logged) but NOT
    applied over BrightBase; only a cancellation in Google propagates back.
    'google': legacy two-way pull — Google edits override the job.
    Settings row 'calendar_source_of_truth' overrides env CALENDAR_SOURCE_OF_TRUTH.
    """
    try:
        from modules.settings.router import get_setting
        val = get_setting(db, "calendar_source_of_truth")
    except Exception:
        val = None
    val = (val or os.getenv("CALENDAR_SOURCE_OF_TRUTH", "brightbase")).strip().lower()
    return "google" if val == "google" else "brightbase"


class GoogleWritebackDisabled(RuntimeError):
    """calendar_source_of_truth == 'google' (legacy two-way pull) was
    selected, but this mode is hard-blocked — see the guard at the top of
    sync_calendar() for why."""


def reassert_deleted_gcal_events(db: Session) -> dict:
    """One-way self-heal (BrightBase is master): find upcoming jobs whose Google
    event was DELETED in Google and clear the stale event id so the push step
    re-creates it on the next reconcile. The ONLY write is clearing a dead id on
    our own jobs — this never imports, edits, or cancels anything.

    Safety is everything here: a false "missing" would make the push create a
    DUPLICATE — the exact thing we're guarding against. So a job is cleared only
    when we POSITIVELY listed Google's events for the window and the job's id is
    absent (or the event is cancelled). If the list call fails, or an
    implausibly large share of linked jobs look missing (an API glitch, not a
    real bulk delete), we clear NOTHING. Only runs in brightbase-master mode.
    """
    # Two-way mode already reconciles deletions via sync_calendar; nothing to do.
    if calendar_source_of_truth(db) == "google":
        return {"skipped": "two_way"}
    try:
        from integrations.google_calendar import _get_service
        service = _get_service()
    except Exception as e:  # not configured / auth failure — no-op
        return {"skipped": "not_configured", "error": str(e)}

    from utils.dates import business_today
    today = business_today()
    win_start, win_end = today, today + timedelta(days=45)

    jobs = db.query(Job).filter(
        Job.gcal_event_id.isnot(None),
        Job.status.in_(["scheduled", "in_progress"]),
        Job.scheduled_date >= win_start.isoformat(),
        Job.scheduled_date <= win_end.isoformat(),
    ).all()
    if not jobs:
        return {"checked": 0, "restored": 0}

    # List Google's events across a slightly WIDER window than the jobs so a job
    # on the boundary day can't look missing just because its event rendered a
    # few hours outside the window.
    time_min = (datetime(win_start.year, win_start.month, win_start.day, tzinfo=timezone.utc) - timedelta(days=2)).isoformat()
    time_max = (datetime(win_end.year, win_end.month, win_end.day, tzinfo=timezone.utc) + timedelta(days=3)).isoformat()

    existing: set[str] = set()
    try:
        for cal_id in resolve_calendar_ids():
            page_token = None
            while True:
                params = {"calendarId": cal_id, "singleEvents": True, "maxResults": 500,
                          "timeMin": time_min, "timeMax": time_max, "orderBy": "startTime"}
                if page_token:
                    # pageToken can't be combined with orderBy/timeMin on some
                    # paths; drop them once we're paging the same result set.
                    params = {"calendarId": cal_id, "singleEvents": True,
                              "maxResults": 500, "pageToken": page_token}
                resp = service.events().list(**params).execute()
                for ev in resp.get("items", []):
                    eid = ev.get("id")
                    if eid and ev.get("status") != "cancelled":
                        existing.add(eid)
                page_token = resp.get("nextPageToken")
                if not page_token:
                    break
    except Exception as e:
        log.warning("[gcal-reassert] events.list failed; clearing nothing: %s", e)
        return {"checked": len(jobs), "restored": 0, "error": str(e)}

    missing = [j for j in jobs if j.gcal_event_id not in existing]
    # Mass-wipe guard: if a large share look missing, assume an API anomaly (a
    # truncated list, a transient scope issue) rather than a real bulk delete —
    # clearing them all would spawn a pile of duplicate events on the next push.
    if missing and len(missing) > max(5, len(jobs) // 2):
        log.warning(
            "[gcal-reassert] %s/%s linked events look missing — implausible; "
            "skipping to avoid duplicate re-creation.", len(missing), len(jobs))
        return {"checked": len(jobs), "restored": 0, "skipped": "guard", "suspected": len(missing)}

    for j in missing:
        j.gcal_event_id = None
        j.gcal_account_id = None
    if missing:
        db.commit()
        log.info("[gcal-reassert] cleared %s deleted Google event id(s) for re-push", len(missing))
    return {"checked": len(jobs), "restored": len(missing)}


# ── Incremental sync (syncToken) ──────────────────────────────────────────
# A per-calendar cursor: after the first bounded full list, Google returns only
# CHANGED events (incl. cancellations) for that token, so polling is cheap and
# can't miss an edit. Stored in AppSetting keyed by calendar id.
def resolve_calendar_ids() -> list[str]:
    """The configured business calendars (residential/commercial/STR), or
    ['primary'] when none are set. Shared by sync + watch registration."""
    ids = list(set(filter(None, [
        os.getenv("GCAL_RESIDENTIAL_ID", "primary"),
        os.getenv("GCAL_COMMERCIAL_ID"),
        os.getenv("GCAL_STR_ID"),
    ])))
    return ids or ["primary"]


def _synctoken_key(cal_id: str) -> str:
    return f"gcal_synctoken:{cal_id}"


def _get_synctoken(db: Session, cal_id: str):
    from database.models import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == _synctoken_key(cal_id)).first()
    return row.value if (row and row.value) else None


def _save_synctoken(db: Session, cal_id: str, token) -> None:
    from database.models import AppSetting
    key = _synctoken_key(cal_id)
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if not token:
        if row:
            db.delete(row)
            db.flush()  # so a same-transaction re-save (410 → fresh token) doesn't collide
        return
    if row:
        row.value = token
    else:
        db.add(AppSetting(key=key, value=token))


def _is_gone(exc: Exception) -> bool:
    """True for an HTTP 410 GONE — an expired/invalid syncToken (full resync)."""
    resp = getattr(exc, "resp", None)
    return bool(resp is not None and getattr(resp, "status", None) in (410,))


def _list_events(service, cal_id: str, sync_token, time_min: str, time_max: str):
    """events.list — incremental when a syncToken is held (syncToken can't be
    combined with timeMin/timeMax/orderBy), otherwise a bounded full list."""
    params = {"calendarId": cal_id, "singleEvents": True, "maxResults": 500}
    if sync_token:
        params["syncToken"] = sync_token
    else:
        params.update(timeMin=time_min, timeMax=time_max, orderBy="startTime")
    return service.events().list(**params).execute()


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
    properties = db.query(Property).filter(Property.active == True).order_by(Property.id).all()
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

    # Then check client addresses (ordered by ID for deterministic matching)
    clients = db.query(Client).filter(Client.address.isnot(None), Client.address != "").order_by(Client.id).all()
    for client in clients:
        client_addr = client.address or ""
        if client.city:
            client_addr += f", {client.city}"
        if client.state:
            client_addr += f", {client.state}"
        if _addresses_match(location, client_addr):
            return {"client": client, "property_id": None, "method": "address_client"}

    return None


def _parse_event_datetime(dt_obj: dict | None) -> "tuple[date, time | None] | None":
    """Parse a GCal start/end object into (datetime.date, datetime.time | None).

    Returns real date/time objects (not strings) so callers can compare and
    assign them to Job's Date/Time columns directly. Comparing a string to a
    Date column always reports "changed" and writes a string back into the
    column — that caused the sync to churn every poll and re-introduced the
    string-in-Date-column bug. Times are truncated to the minute (GCal only
    surfaces minutes here).

    We want the event's *property-local* wall clock — the time the cleaner shows
    up — and _build_event creates events in the property's timezone. GCal echoes
    that back as a `timeZone` field plus a dateTime with that zone's offset.
    Three cases:

      1. A `timeZone` field is present → convert to it and take the wall clock.
         Authoritative for ANY property timezone (a 09:00 Pacific event stays
         09:00, not 12:00 Eastern).
      2. No timeZone, value is bare UTC ("13:00Z") → no local context in the
         value, so recover the wall clock in BUSINESS_TZ (Maine/Eastern). This
         is the original 'Z'-churn fix and matches the rehydrate endpoint.
      3. No timeZone, explicit non-UTC offset ("09:00-07:00") → the offset is
         already the local wall clock; take .time() as-is, no conversion (else
         non-Eastern properties get rewritten to the wrong hour every sync).
    """
    if not dt_obj:
        return None
    if "dateTime" in dt_obj:
        dt = datetime.fromisoformat(dt_obj["dateTime"].replace("Z", "+00:00"))
        tzname = dt_obj.get("timeZone")
        if tzname:
            try:
                dt = dt.astimezone(ZoneInfo(tzname))
            except Exception:
                # Unknown/garbage zone string — fall through to the value's own
                # offset rather than corrupting the time.
                pass
        elif dt.tzinfo is not None and dt.utcoffset() == timedelta(0):
            # Bare UTC with no zone hint: best-guess the business wall clock.
            dt = dt.astimezone(BUSINESS_TZ)
        # else: explicit non-UTC offset and no timeZone — already property-local.
        return dt.date(), dt.time().replace(second=0, microsecond=0)
    if "date" in dt_obj:
        return date.fromisoformat(dt_obj["date"]), None
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
    3. A matched event proposes a Job (ProposedAction, kind=
       "create_job_from_gcal") for human review instead of creating one
       directly — scheduling-invariants Rule 0 / R2: Google Calendar is a
       projection, not a sanctioned inbox, so a read from it must never write
       canonical state. See services/proposals.py.
    4. For already-linked jobs, detect GCal changes and update

    Returns a summary of what happened.

    HARD BLOCK (scheduling-invariants Rule 0 / R2): when
    calendar_source_of_truth resolves to 'google', this function refuses to
    run at all rather than silently pulling Google's edits over canonical Job
    rows. Google Calendar is a projection, never a peer — see the
    `scheduling-invariants` skill and docs/scheduling-sync-redesign.md
    (Phase 4, "make Google strictly one-way"). The 'google'-mode pull logic
    below is left in place, unreached, so a deliberate future re-enable
    (Meg's explicit sign-off, per that skill's "Changing These Rules"
    process) doesn't require resurrecting deleted code — just removing this
    guard.
    """
    source_of_truth = calendar_source_of_truth(db)
    if source_of_truth == "google":
        log.critical(
            "[gcal-sync] BLOCKED: calendar_source_of_truth='google' (legacy "
            "two-way pull) is disabled — pulling Google Calendar edits into "
            "canonical Job rows violates scheduling-invariants Rule 0 / R2 "
            "(no writeback from a projection). Settings -> Automation -> "
            "Two-way sync is set to 'google' for this org; switch it back to "
            "'BrightBase is the master' to resume syncing. sync_calendar() "
            "is refusing to run until then."
        )
        raise GoogleWritebackDisabled(
            "calendar_source_of_truth='google' (legacy two-way pull) is "
            "hard-blocked: it lets Google Calendar edits overwrite canonical "
            "BrightBase Job rows, which violates scheduling-invariants Rule 0 "
            "/ R2 (no writeback from a projection — reading Google is only "
            "for computing drift). Set Settings -> Automation -> Two-way "
            "sync back to 'BrightBase is the master'. To deliberately "
            "re-enable this mode, get explicit owner sign-off first and "
            "follow the 'Changing These Rules' process in the "
            "scheduling-invariants skill (see also "
            "docs/scheduling-sync-redesign.md, Phase 4)."
        )

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
        calendar_ids = resolve_calendar_ids()

    # Time range: 30 days back, 90 days forward
    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(days=30)).isoformat() + "Z"
    time_max = (now + timedelta(days=90)).isoformat() + "Z"

    results = {
        "calendars_synced": 0,
        "events_scanned": 0,
        # Matched events land here for review, not straight into Job rows
        # (scheduling-invariants R2) — see the create_job_from_gcal proposal
        # block below. "jobs_created" is gone: this path no longer creates
        # jobs directly, so a stale key that always reads 0 would mislead.
        "proposals_created": 0,
        "proposals_skipped": 0,   # matched event already has a proposal on file (any status)
        "jobs_updated": 0,
        "jobs_cancelled": 0,
        "matched_by": {"extendedProperties": 0, "attendee_email": 0, "address_property": 0, "address_client": 0},
        "unmatched": 0,
        "drift_detected": 0,
        "errors": [],
    }
    # source_of_truth is resolved and guarded at the top of this function —
    # by this point it can only be "brightbase" (the "google" case already
    # raised GoogleWritebackDisabled above).

    incremental = env_flag("GCAL_INCREMENTAL_SYNC", True)

    for cal_id in calendar_ids:
        if not cal_id:
            continue
        token = _get_synctoken(db, cal_id) if incremental else None
        try:
            events_result = _list_events(service, cal_id, token, time_min, time_max)
        except Exception as e:
            # An expired/invalid syncToken returns HTTP 410 — drop it and fall
            # back to a bounded full resync (Google's prescribed recovery).
            if token and _is_gone(e):
                _save_synctoken(db, cal_id, None)
                try:
                    events_result = _list_events(service, cal_id, None, time_min, time_max)
                except Exception as e2:
                    results["errors"].append({"calendar": cal_id, "error": str(e2)})
                    continue
            else:
                results["errors"].append({"calendar": cal_id, "error": str(e)})
                continue

        results["calendars_synced"] += 1
        events = events_result.get("items", [])
        # Persist the cursor for next time — only changed events come back after
        # this, so polling is cheap and never misses an edit.
        next_token = events_result.get("nextSyncToken")
        if incremental and next_token:
            _save_synctoken(db, cal_id, next_token)

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

                # Idempotency: remember Google's stable iCalUID so a future
                # re-created/moved event can be re-matched as the same booking.
                if not existing_job.gcal_ical_uid and event.get("iCalUID"):
                    existing_job.gcal_ical_uid = event.get("iCalUID")

                # Detect cancellation — ALWAYS wins, both directions.
                if event.get("status") == "cancelled":
                    if existing_job.status != "cancelled":
                        existing_job.status = "cancelled"
                        results["jobs_cancelled"] += 1
                    continue

                # Source-of-truth: when BrightBase is the master (default), a
                # reschedule/edit made directly in Google does NOT overwrite the
                # job — it's surfaced as drift. BrightBase re-asserts its values on
                # the next push. source_of_truth is always "brightbase" here —
                # the "google" (two-way pull) case is hard-blocked by the guard
                # at the top of this function, which raises before this loop is
                # ever reached. The `else` below (the pull) is therefore dead by
                # design; it's left in place, not deleted, so a deliberate future
                # re-enable doesn't require resurrecting removed code — see the
                # guard's docstring/comment for the process to re-enable it.
                if source_of_truth == "brightbase":
                    start = event.get("start", {})
                    parsed_start = _parse_event_datetime(start)
                    gcal_title = _s(event.get("summary"))
                    gcal_location = _s(event.get("location"))
                    drift = bool(gcal_title and gcal_title != existing_job.title) \
                        or bool(gcal_location and gcal_location != (existing_job.address or ""))
                    if parsed_start:
                        g_date, g_time = parsed_start
                        drift = drift or g_date != existing_job.scheduled_date \
                            or (g_time and g_time != existing_job.start_time)
                    if drift:
                        results.setdefault("drift_detected", 0)
                        results["drift_detected"] += 1
                        log.info(
                            "[gcal-sync] drift on job %s (event %s) ignored — BrightBase is "
                            "source of truth; will re-assert on next push", existing_job.id, gcal_id,
                        )
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

            # Idempotency: an event we already know by its stable iCalUID — but
            # whose event id changed (e.g. recreated) — is the SAME booking. Relink
            # it instead of creating a duplicate job.
            ical_uid = event.get("iCalUID")
            if ical_uid:
                known = db.query(Job).filter(Job.gcal_ical_uid == ical_uid).first()
                if known:
                    known.gcal_event_id = gcal_id
                    continue

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
            effective_start = start_time or time(9, 0)
            effective_end = end_time or time(12, 0)
            org_id = client.org_id

            # scheduling-invariants Rule 0 / R2: a matched event does NOT
            # become a Job directly from this read — Google Calendar is a
            # projection, not a sanctioned inbox (only iCal/Airbnb feeds are).
            # Record a ProposedAction instead (the same raw-capture-then-
            # promote pattern those feeds use); a human approves it on the Ops
            # board to create the real Job through create_job (conflict
            # detection + the real GCal push ride along), or dismisses it to
            # ignore the event. Deterministic payload (no wall-clock values)
            # so create_proposal's own pending-dedupe is effective across polls.
            title = (f"New job from Google Calendar: "
                     f"'{event.get('summary', 'Cleaning')}' on {sched_date.isoformat()}")
            detail = (
                f"Matched to {client.name} by {_MATCH_LABELS.get(match['method'], match['method'])} "
                f"· {effective_start.strftime('%H:%M')}–{effective_end.strftime('%H:%M')}. "
                f"Approving creates the job through the normal schedule write path; "
                f"dismissing ignores this calendar event."
            )
            payload = {
                "client_id": client.id,
                "title": event.get("summary", "Cleaning"),
                "job_type": job_type,
                "scheduled_date": sched_date.isoformat(),
                "start_time": effective_start.strftime("%H:%M"),
                "end_time": effective_end.strftime("%H:%M"),
                "address": event.get("location", client.address or ""),
                "property_id": match.get("property_id"),
                "notes": _s(event.get("description")),
                "gcal_event_id": gcal_id,
                "gcal_ical_uid": event.get("iCalUID"),
            }

            # Idempotency beyond create_proposal's own pending-dedupe: a
            # proposal for this exact event already exists in ANY status —
            # pending (don't duplicate the review queue), dismissed (a human
            # already said no; don't re-ask every poll — the earlier "spam"
            # complaint pattern, just relocated), executed (its Job should
            # already be caught by the gcal_event_id lookup above — this is
            # belt-and-suspenders), or failed (a stale client match or
            # conflict at approval time doesn't self-heal just because the
            # poll ran again; treated the same as dismissed — a human needs to
            # look at it and act, e.g. create the job by hand). So: propose
            # once per event, ever, unless a human's own decision reopens it.
            already_proposed = any(
                (row.payload or {}).get("gcal_event_id") == gcal_id
                for row in db.query(ProposedAction).filter(
                    ProposedAction.org_id == org_id,
                    ProposedAction.kind == "create_job_from_gcal",
                ).all()
            )
            if already_proposed:
                results["proposals_skipped"] += 1
                continue

            create_proposal(
                db, org_id=org_id, agent_id="mia", kind="create_job_from_gcal",
                title=title, detail=detail, payload=payload,
            )
            results["proposals_created"] += 1

    db.commit()

    total = results["proposals_created"] + results["jobs_updated"] + results["jobs_cancelled"]
    results["message"] = (
        f"Synced {results['events_scanned']} events from {results['calendars_synced']} calendar(s). "
        f"{results['proposals_created']} new job(s) proposed for review, "
        f"updated {results['jobs_updated']}, cancelled {results['jobs_cancelled']}. "
        f"{results['unmatched']} unmatched."
    )
    return results


def sync_gcal_cancellations(db: Session) -> dict:
    """Reverse linkage check: for every Job that has a gcal_event_id, ask
    Google whether the event still exists. If it's gone (404/410) or its
    status is 'cancelled', soft-cancel the Job + its Visits. If the Job
    was created from a recurring schedule, also write a RecurrenceException
    so the next /generate-all run doesn't recreate the date.

    The existing sync_calendar() catches events that come back as
    status='cancelled' from events.list. But fully-deleted events
    disappear from events.list entirely, leaving the linked Job orphaned.
    This function is the missing other half of two-way GCal sync.

    Returns a stats dict with how many were touched.
    """
    from database.models import Job, RecurrenceException
    from integrations.google_calendar import get_event

    out = {
        "checked": 0,
        "still_present": 0,
        "deleted_or_cancelled": 0,
        "exceptions_written": 0,
        "errors": 0,
        "would_cancel": 0,
        "circuit_breaker_tripped": False,
    }

    jobs = (
        db.query(Job)
        .filter(
            Job.gcal_event_id.isnot(None),
            Job.gcal_event_id != "",
            Job.status.notin_(("cancelled", "completed")),
        )
        .all()
    )
    out["checked"] = len(jobs)

    # === CIRCUIT BREAKER PRE-PASS ===
    # Before mutating anything, fetch every GCal event and count how many
    # would be cancelled. If that's more than 20% of the checked set (and
    # more than 5 jobs absolute), refuse to cancel any of them. Prevents
    # mass-cancellation events caused by auth lapses, calendar ID swaps,
    # or transient Google API issues returning None for every event.
    fetched = {}  # job_id -> (event, error)
    would_cancel = 0
    for job in jobs:
        try:
            event = get_event(job.gcal_event_id, job_type=job.job_type or "residential",
                              owner_account_id=getattr(job, "gcal_account_id", None))
            fetched[job.id] = (event, None)
            if event is None or event.get("status") == "cancelled":
                would_cancel += 1
        except Exception as e:
            fetched[job.id] = (None, e)

    out["would_cancel"] = would_cancel

    MAX_CANCEL_RATIO = 0.20
    MIN_TRIP_COUNT = 5
    if would_cancel > MIN_TRIP_COUNT and len(jobs) > 0:
        cancel_ratio = would_cancel / len(jobs)
        if cancel_ratio > MAX_CANCEL_RATIO:
            out["circuit_breaker_tripped"] = True
            log.critical(
                f"[gcal-cancellations] CIRCUIT-BREAKER TRIPPED: would "
                f"cancel {would_cancel}/{len(jobs)} jobs "
                f"({cancel_ratio*100:.0f}%). Refusing to cancel any this "
                f"tick. Possible causes: GCal auth issue, calendar ID "
                f"mismatch, or API outage. If intentional, run the sync "
                f"manually or temporarily disable gcal_auto_sync_enabled."
            )
            return out
    # === END CIRCUIT BREAKER ===

    for job in jobs:
        event, err = fetched[job.id]
        if err is not None:
            # Transient Google error or auth issue — don't cascade-cancel
            # jobs because of an integration hiccup. Skip and let the next
            # tick try.
            log.warning(f"[gcal-cancellations] get_event failed for job {job.id}: {err}")
            out["errors"] += 1
            continue

        if event is not None and event.get("status") != "cancelled":
            out["still_present"] += 1
            continue

        # Event is gone (None) or marked cancelled. Soft-cancel the Job.
        out["deleted_or_cancelled"] += 1
        job.status = "cancelled"
        job.notes = ((job.notes or "") + "\n[Cancelled via Google Calendar deletion]").strip()

        # If recurring, write a durable exception so the next /generate-all
        # doesn't resurrect the date. Idempotent via the unique
        # (recurring_schedule_id, exception_date) constraint.
        if job.recurring_schedule_id and job.scheduled_date:
            existing = (
                db.query(RecurrenceException)
                .filter(
                    RecurrenceException.recurring_schedule_id == job.recurring_schedule_id,
                    RecurrenceException.exception_date == job.scheduled_date,
                )
                .first()
            )
            if existing is None:
                db.add(RecurrenceException(
                    recurring_schedule_id=job.recurring_schedule_id,
                    exception_date=job.scheduled_date,
                    exception_type="skip",
                    reason="Cancelled via Google Calendar deletion",
                ))
                out["exceptions_written"] += 1

    if out["deleted_or_cancelled"] > 0 or out["exceptions_written"] > 0:
        db.commit()

    log.info(
        f"[gcal-cancellations] checked={out['checked']} "
        f"deleted_or_cancelled={out['deleted_or_cancelled']} "
        f"exceptions_written={out['exceptions_written']} "
        f"errors={out['errors']}"
    )
    return out
