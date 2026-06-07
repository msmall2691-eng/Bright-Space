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
# Module-level alias for the synchronous client so tests can patch
# integrations.ical_sync._httpx.Client (it used to be a function-local import,
# which isn't patchable from the module namespace).
import httpx as _httpx
import re
import socket
import ipaddress
from urllib.parse import urlparse
from icalendar import Calendar


def _assert_public_url(url: str) -> None:
    """SSRF guard for operator-supplied iCal feed URLs. Only allow http(s) to a
    publicly-routable host; reject anything that resolves to a private, loopback,
    link-local (incl. the 169.254.169.254 cloud-metadata endpoint), reserved, or
    multicast address. Without this, an admin (or a leaked API key) could point a
    feed at internal services and have the scheduler fetch them every cycle.
    Raises ValueError on a disallowed URL."""
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"unsupported scheme {parsed.scheme!r}")
    host = parsed.hostname
    if not host:
        raise ValueError("missing host")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError(f"cannot resolve host ({e})")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise ValueError(f"resolves to non-public address {ip}")

from datetime import datetime, date, timedelta, time as time_type, timezone
from pytz import timezone as pytz_timezone
from sqlalchemy.orm import Session
from database.models import Property, ICalEvent, Job, Client, PropertyIcal
import logging

log = logging.getLogger(__name__)


def _parse_date(val, default_tz: str | None = None) -> str | None:
    """Convert an icalendar date/datetime to a ``YYYY-MM-DD`` string in
    the property's local timezone.

    Why TZ matters here: feeds vary in how they encode checkout times.
    - Airbnb uses ``VALUE=DATE`` (all-day, no time, no TZ). Treat as
      the calendar date directly.
    - VRBO / Booking.com / manual ICS files sometimes use
      ``VALUE=DATE-TIME`` with a ``TZID`` or trailing ``Z``. Without
      converting to the property's local TZ, a ``2026-04-20T04:00:00Z``
      checkout from a New York property would naively decode to
      2026-04-20 in summer (UTC-4 → still Apr 20 local) but to
      2026-04-19 in winter (UTC-5 → 23:00 the previous day). That's
      the off-by-one we were seeing on the Pier House schedule.

    If the value is tz-aware, convert to ``default_tz`` before taking
    ``.date()``. If naive, assume it's already in the property's
    local TZ. Falls back to ``America/New_York`` when ``default_tz``
    is None or invalid (operating region for the only ME-based
    deployment today).
    """
    if val is None:
        return None
    if hasattr(val, "dt"):
        val = val.dt
    if isinstance(val, datetime):
        if val.tzinfo is not None:
            try:
                local_tz = pytz_timezone(default_tz or "America/New_York")
                val = val.astimezone(local_tz)
            except Exception:
                # Bad TZ string — fall through to naive .date(); better
                # to keep the old behavior for this row than crash the
                # whole sync.
                pass
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


def _to_time(s):
    """Parse an 'HH:MM' or 'HH:MM:SS' string into a datetime.time, so Job's
    Time columns get a real time object (works the same on Postgres and SQLite
    instead of relying on Postgres's implicit string->time cast)."""
    from datetime import datetime as _dt
    if not s:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return _dt.strptime(s, fmt).time()
        except (ValueError, TypeError):
            continue
    return None


def _to_date(value):
    """Coerce an ISO date string (or date) into a datetime.date so Job's Date
    column gets a real date object on both Postgres and SQLite."""
    if value is None or isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _nights_between(checkin, checkout):
    """Number of guest nights between checkin and checkout (ISO strings/dates),
    or None if either is missing/unparseable."""
    ci, co = _to_date(checkin), _to_date(checkout)
    if ci and co:
        return (co - ci).days
    return None


# A calendar event is treated as a real guest reservation (→ turnover cleaning)
# UNLESS its title clearly marks it as a host block (owner stay, maintenance,
# manually blocked dates). We match these as the *exclusion* list rather than
# requiring a "Reserved"/"Airbnb" allowlist, because real bookings on VRBO,
# Hospitable/Guesty, and other platforms often have a blank title, the guest's
# name, or platform-specific wording that an allowlist silently drops.
# Short, ambiguous words ("owner", "blocked") use \b word boundaries so we don't
# false-match guest/property names like "Downtowner" or "Block Island".
_HOST_BLOCK_RE = re.compile(
    r"not available|unavailable|not bookable|do not book|do-not-book|"
    r"\bblocked\b|\bmaintenance\b|\bowner\b|\bhold\b",
    re.IGNORECASE,
)


def _is_host_block(summary: str) -> bool:
    """True if the event title marks a host block / non-booking rather than a
    guest reservation."""
    return bool(_HOST_BLOCK_RE.search(summary or ""))


def _push_turnover_to_gcal(db, prop, linked_job, checkout_date) -> None:
    """Update the linked Google Calendar event to match the turnover's current
    date/time.

    CRITICAL for the GCal-as-source-of-truth model: gcal_sync treats Google
    Calendar events as authoritative and writes their start date BACK onto the
    Job (see gcal_sync.py). So any time we change a linked turnover's date in our
    DB, we must push that change to Google too — otherwise the next Google sync
    overwrites our change and the turnover drifts back to the wrong day. Both the
    reschedule path (feed checkout moved) and the reconcile path (linked job had
    a stale/empty date) go through here. No-op if the job has no GCal event yet.
    """
    if not getattr(linked_job, "gcal_event_id", None):
        return
    try:
        from integrations.google_calendar import update_event
        client_for_update = db.query(Client).filter_by(id=prop.client_id).first()
        job_dict = {
            "id": linked_job.id,
            "title": linked_job.title,
            "job_type": "str_turnover",
            "scheduled_date": checkout_date,
            "start_time": str(linked_job.start_time) if linked_job.start_time else "10:00",
            "end_time": str(linked_job.end_time) if linked_job.end_time else "13:00",
            "address": prop.address,
            "notes": linked_job.notes or "",
            "property_id": prop.id,
        }
        client_dict = {
            "id": prop.client_id,
            "name": client_for_update.name if client_for_update else "Client",
            "email": getattr(client_for_update, "email", None) if client_for_update else None,
        }
        update_event(linked_job.gcal_event_id, job_dict, client_dict)
        log.info(
            f"Updated GCal event {linked_job.gcal_event_id} for turnover "
            f"{linked_job.id} → {checkout_date}"
        )
    except Exception as e:
        log.warning(f"Failed to update GCal for turnover {linked_job.id}: {e}")


async def fetch_ical(url: str) -> bytes:
    _assert_public_url(url)
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
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
    # Fetch feed (uses the module-level _httpx alias so it stays patchable)
    try:
        _assert_public_url(ical_url)
    except ValueError as e:
        log.warning(f"Refusing to fetch unsafe iCal URL {ical_url}: {e}")
        return {"error": f"Refusing unsafe iCal URL: {e}"}
    try:
        with _httpx.Client(timeout=15, follow_redirects=False) as client:
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
    cancelled_jobs = 0
    rescheduled_jobs = 0
    skipped_host_blocks = 0
    skipped_not_reserved = 0

    # Collect all events first to enable back-to-back lookup
    events_by_checkout = {}  # For finding next booking
    all_events = []
    feed_uids = set()  # Track UIDs seen in this sync for cancellation detection

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        uid = str(component.get("UID", ""))
        if not uid:
            continue

        summary = str(component.get("SUMMARY", ""))
        description = str(component.get("DESCRIPTION", ""))

        # Treat every event as a guest reservation UNLESS its title clearly marks
        # it as a host block. The old logic *also* required the title to contain
        # "reserved"/"airbnb", which silently dropped real bookings whose title
        # was blank, a guest name, or a non-Airbnb platform's wording — the cause
        # of missing turnovers. (skipped_not_reserved is kept in the result shape
        # for compatibility but is no longer used.)
        if _is_host_block(summary):
            skipped_host_blocks += 1
            log.info(f"Skipping host block: {summary!r}")
            continue

        # Parse dates — pass the property's local TZ so tz-aware DTEND
        # values get converted before the date() call. Property.timezone
        # may legitimately be empty for non-STR rows; _parse_date falls
        # back to America/New_York in that case.
        dtstart_raw = component.get("DTSTART")
        dtend_raw = component.get("DTEND")

        prop_tz = prop.timezone or "America/New_York"
        checkin_date = _parse_date(dtstart_raw, default_tz=prop_tz)
        checkout_raw = _parse_date(dtend_raw, default_tz=prop_tz)

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

        feed_uids.add(uid)
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
            # Detect date changes — guest rescheduled
            old_checkout = event.checkout_date
            if old_checkout != checkout_date:
                log.info(
                    f"Date change detected for {prop.name}: "
                    f"booking {uid} moved from {old_checkout} to {checkout_date}"
                )
                event.checkout_date = checkout_date
                event.checkin_date = checkin_date
                # If linked to a job, update the job + GCal event
                if event.job_id:
                    linked_job = db.query(Job).filter(Job.id == event.job_id).first()
                    if linked_job and linked_job.status not in ("cancelled", "completed"):
                        linked_job.scheduled_date = _to_date(checkout_date)
                        rescheduled_jobs += 1
                        # Keep Google Calendar in step (it's authoritative on the
                        # next sync) so the move isn't reverted.
                        _push_turnover_to_gcal(db, prop, linked_job, checkout_date)

        # A stale event.job_id used to make the sync skip recreation forever —
        # "no new turnovers" while the calendar stayed empty. Two cases:
        #   1. The Job was hard-deleted (data reset / "Delete scheduled visits").
        #   2. The Job was CANCELLED — manually, or when its Google Calendar event
        #      was deleted — but the booking is still active in the feed.
        # In both cases the cancelled/missing turnover stays hidden and the
        # cleaning is silently lost. Policy: a booking that's still in the feed
        # always keeps a turnover, so drop the stale link and recreate below.
        # Completed jobs are left alone — that work is already done.
        if event.job_id:
            _linked = db.query(Job).filter(Job.id == event.job_id).first()
            if _linked is None or _linked.status == "cancelled":
                if _linked is not None:
                    log.info(
                        f"Resurrecting turnover for {prop.name} ({uid}): linked job "
                        f"{_linked.id} was '{_linked.status}' but the booking is still "
                        f"active in the feed — recreating."
                    )
                event.job_id = None
            elif _linked.status != "completed":
                # Case 3: the linked turnover is active but lost its date. Old
                # data resets / the VARCHAR→DATE migration left some linked jobs
                # with a NULL or stale scheduled_date — "linked" but invisible on
                # the calendar. Reconcile it to the feed checkout (source of
                # truth) and re-fill a missing start time so it shows up.
                want = _to_date(checkout_date)
                if want and _linked.scheduled_date != want:
                    log.info(
                        f"Reconciling turnover {_linked.id} for {prop.name} ({uid}): "
                        f"scheduled_date {_linked.scheduled_date} → {want}"
                    )
                    _linked.scheduled_date = want
                    if not _linked.start_time:
                        _linked.start_time = _to_time(
                            (property_ical.checkout_time if property_ical else None)
                            or prop.check_out_time or "10:00"
                        )
                    # Push the corrected date to Google Calendar — otherwise the
                    # next GCal sync (which treats its event as authoritative)
                    # would write the stale date straight back onto the job.
                    _push_turnover_to_gcal(db, prop, _linked, checkout_date)
                elif not _linked.start_time:
                    _linked.start_time = _to_time(
                        (property_ical.checkout_time if property_ical else None)
                        or prop.check_out_time or "10:00"
                    )

        # Create a Job if: no live job yet + checkout is today or future
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

            # Extract guest metadata + capture the full booking window so each
            # turnover carries its guest context (stay dates, nights, source UID).
            guest_metadata = _extract_guest_metadata(description)
            guest_metadata['ical_source_label'] = ical_source_label
            guest_metadata['booking_uid'] = uid
            guest_metadata['checkin_date'] = checkin_date
            guest_metadata['checkout_date'] = checkout_date
            _nights = _nights_between(checkin_date, checkout_date)
            if _nights is not None:
                guest_metadata['nights'] = _nights

            # Get client for GCal invite
            client = db.query(Client).filter_by(id=prop.client_id).first()
            client_name = client.name if client else "Client"

            # Build notes with the stay window, reservation code, phone, code.
            notes_parts = [f"Guest checkout. Booking: {summary}"]
            if checkin_date:
                stay = f"Stay: {checkin_date} → {checkout_date}"
                if _nights is not None:
                    stay += f" ({_nights} night{'s' if _nights != 1 else ''})"
                notes_parts.append(stay)
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
                scheduled_date=date.fromisoformat(checkout_date) if isinstance(checkout_date, str) else checkout_date,
                start_time=_to_time(check_out_time),
                end_time=_to_time(end_time),
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

            # Push to Google Calendar with guest metadata + property info in description
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
                # Property metadata for richer GCal event description
                property_data = {
                    "timezone": prop.timezone,
                    "house_code": house_code,
                    "access_notes": prop.access_notes,
                    "parking_notes": prop.parking_notes,
                    "site_contact_name": prop.site_contact_name,
                    "site_contact_phone": prop.site_contact_phone,
                }
                gcal_event_id = create_event(job_dict, client_dict, property_data=property_data)
                if gcal_event_id:
                    job.gcal_event_id = gcal_event_id
                    job.calendar_invite_sent = True
                    log.info(f"Pushed turnover to GCal: {prop.name} on {checkout_date} (event={gcal_event_id})")
            except Exception as e:
                log.warning(f"Failed to push turnover to GCal for {prop.name} on {checkout_date}: {e}")

    # Cancellation detection: find future ICalEvents whose UIDs no longer appear in the feed
    # These represent cancelled bookings — we should cancel the linked Job + delete GCal event
    if feed_uids:  # Only run if we successfully parsed at least some events
        existing_future_events = db.query(ICalEvent).filter(
            ICalEvent.property_id == prop.id,
            ICalEvent.checkout_date >= today,
            ICalEvent.event_type == "reservation",
        ).all()

        for existing in existing_future_events:
            if existing.uid in feed_uids:
                continue  # Still in feed — skip
            # Booking disappeared from feed → cancellation
            log.info(
                f"Cancellation detected for {prop.name}: "
                f"booking {existing.uid} (checkout {existing.checkout_date}) no longer in feed"
            )
            # Cancel the linked job
            if existing.job_id:
                linked_job = db.query(Job).filter(Job.id == existing.job_id).first()
                if linked_job and linked_job.status not in ("cancelled", "completed"):
                    linked_job.status = "cancelled"
                    cancelled_jobs += 1
                    # Delete GCal event if linked
                    if linked_job.gcal_event_id:
                        try:
                            from integrations.google_calendar import delete_event
                            delete_event(linked_job.gcal_event_id, "str_turnover")
                            log.info(f"Deleted GCal event {linked_job.gcal_event_id} for cancelled turnover")
                        except Exception as e:
                            log.warning(f"Failed to delete GCal for cancelled turnover: {e}")
                # Phase 0 fix: drop the link to the cancelled Job. Without this,
                # if the same UID reappears (guest rebooks) the next sync sees
                # event.job_id set and treats it as already-linked, leaving the
                # cancelled Job in place and skipping new-Job creation.
                existing.job_id = None
            # Mark the iCal event as cancelled (audit trail)
            existing.event_type = "cancelled"

    db.commit()

    # Coverage safety-net: after everything above, EVERY future guest booking in
    # the feed should now have an active turnover. Re-check and report any that
    # don't, so a silently-missed checkout surfaces loudly instead of vanishing.
    active_turnover_dates = {
        j.scheduled_date.isoformat() if hasattr(j.scheduled_date, "isoformat") else str(j.scheduled_date)
        for j in db.query(Job).filter(
            Job.property_id == prop.id,
            Job.job_type == "str_turnover",
            Job.status.notin_(["cancelled"]),
            Job.scheduled_date.isnot(None),
        ).all()
        if j.scheduled_date
    }
    future_bookings = 0
    missing_turnovers = []
    for ev in all_events:
        co = ev.get("checkout_date")
        if not co or _is_host_block(ev.get("summary", "")) or co < today:
            continue
        future_bookings += 1
        co_str = co if isinstance(co, str) else (co.isoformat() if hasattr(co, "isoformat") else str(co))
        if co_str not in active_turnover_dates:
            missing_turnovers.append({"checkout": co_str, "summary": ev.get("summary", ""), "uid": ev.get("uid", "")[:60]})
    if missing_turnovers:
        log.error(
            f"[coverage] {prop.name}: {len(missing_turnovers)} future booking(s) "
            f"have NO turnover after sync: {[m['checkout'] for m in missing_turnovers]}"
        )

    return {
        "events_seen": seen,
        "events_created": created_events,
        "jobs_created": created_jobs,
        "jobs_cancelled": cancelled_jobs,
        "jobs_rescheduled": rescheduled_jobs,
        "skipped_host_blocks": skipped_host_blocks,
        "skipped_not_reserved": skipped_not_reserved,
        "future_bookings": future_bookings,
        "missing_turnovers": missing_turnovers,
    }


def _backfill_turnover_gcal(db: Session, prop: Property) -> int:
    """Self-heal: push any future turnover Jobs for this property that don't yet
    have a Google Calendar event.

    The per-event push only fires when a Job is first created, so turnovers
    created while Google was disconnected (or during a transient failure) never
    reach the calendar. Running this every sync means that the moment Google is
    connected, all the missing turnovers appear automatically — no manual
    'Push to Google'. Idempotent: gcal_event_id is set on success, so each event
    is created exactly once."""
    jobs = (
        db.query(Job)
        .filter(
            Job.property_id == prop.id,
            Job.job_type == "str_turnover",
            Job.status.in_(("scheduled", "in_progress")),
            Job.gcal_event_id.is_(None),
            Job.scheduled_date.isnot(None),
            Job.scheduled_date >= datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        )
        .all()
    )
    if not jobs:
        return 0
    try:
        from integrations.google_calendar import create_event
    except Exception:
        return 0

    client = db.query(Client).filter_by(id=prop.client_id).first()
    client_dict = {
        "id": prop.client_id,
        "name": client.name if client else "Client",
        "email": getattr(client, "email", None) if client else None,
    }
    property_data = {
        "timezone": prop.timezone, "house_code": prop.house_code,
        "access_notes": prop.access_notes, "parking_notes": prop.parking_notes,
        "site_contact_name": prop.site_contact_name, "site_contact_phone": prop.site_contact_phone,
    }
    healed = 0
    for job in jobs:
        start_time = job.start_time or prop.check_out_time or "10:00"
        end_time = job.end_time or _make_end_time(start_time, prop.default_duration_hours or 3.0)
        job_dict = {
            "id": job.id, "title": job.title, "job_type": "str_turnover",
            "scheduled_date": job.scheduled_date, "start_time": start_time,
            "end_time": end_time, "address": job.address or prop.address,
            "notes": job.notes, "property_id": prop.id,
        }
        try:
            eid = create_event(job_dict, client_dict, property_data=property_data)
            if eid:
                job.gcal_event_id = eid
                healed += 1
        except Exception as e:
            log.warning(f"[turnover self-heal] GCal push failed for job {job.id}: {e}")
    if healed:
        db.commit()
        log.info(f"[turnover self-heal] pushed {healed} missing turnover(s) to GCal for {prop.name}")
    return healed


def sync_property(db: Session, prop: Property, only_ical_id: int = None) -> dict:
    """
    Sync a property's iCal feeds (both legacy ical_url and PropertyIcal entries).
    Returns summary dict.
    Designed to be called from an API route or background task.

    If ``only_ical_id`` is given, only that PropertyIcal feed is synced (used by
    the per-feed retry endpoint) — the legacy ical_url and other feeds are
    skipped.
    """
    if not prop.ical_url and not prop.property_icals:
        return {"error": "No iCal URLs configured for this property"}

    total_seen = 0
    total_created_events = 0
    total_created_jobs = 0
    total_cancelled_jobs = 0
    total_rescheduled_jobs = 0
    total_skipped_host_blocks = 0
    total_skipped_not_reserved = 0
    total_future_bookings = 0
    missing_turnovers = []
    sources_synced = []
    # Per-source failures. The legacy ical_url has no PropertyIcal row to record
    # its status on, so a failed legacy feed would otherwise be invisible to
    # callers (e.g. the turnover sweep) and the property could be reported
    # healthy off stale events. Collect every source's error here and expose it.
    sync_errors = []

    # Sync legacy ical_url first if it exists (skipped in single-feed mode)
    if prop.ical_url and only_ical_id is None:
        result = _sync_ical_url(db, prop, prop.ical_url, ical_source_label="legacy")
        if "error" not in result:
            total_seen += result["events_seen"]
            total_created_events += result["events_created"]
            total_created_jobs += result["jobs_created"]
            total_cancelled_jobs += result.get("jobs_cancelled", 0)
            total_rescheduled_jobs += result.get("jobs_rescheduled", 0)
            total_skipped_host_blocks += result["skipped_host_blocks"]
            total_skipped_not_reserved += result["skipped_not_reserved"]
            total_future_bookings += result.get("future_bookings", 0)
            missing_turnovers.extend(result.get("missing_turnovers", []))
            sources_synced.append("legacy_ical_url")
        else:
            sync_errors.append({"source": "legacy_ical_url", "error": str(result.get("error", ""))[:200]})

    # Sync all PropertyIcal entries (or just one, in single-feed retry mode)
    for prop_ical in (prop.property_icals or []):
        if only_ical_id is not None and prop_ical.id != only_ical_id:
            continue
        if not prop_ical.active:
            continue
        result = _sync_ical_url(
            db, prop, prop_ical.url,
            ical_source_label=prop_ical.source or "unknown",
            property_ical=prop_ical
        )
        # Always record sync attempt outcome so the operator UI can show
        # an accurate status pill — last_synced_at alone with no status
        # left the FE unable to distinguish "successful" from "never run"
        # (Codex P1 on #93).
        prop_ical.last_synced_at = datetime.now(timezone.utc)
        if "error" in result:
            prop_ical.last_sync_status = "failed"
            prop_ical.last_sync_error = str(result.get("error", ""))[:500]
            prop_ical.sync_retry_count = (prop_ical.sync_retry_count or 0) + 1
            sync_errors.append({"source": prop_ical.source or "feed", "error": str(result.get("error", ""))[:200]})
        else:
            prop_ical.last_sync_status = "ok"
            prop_ical.last_sync_error = None
            prop_ical.sync_retry_count = 0
            total_seen += result["events_seen"]
            total_created_events += result["events_created"]
            total_created_jobs += result["jobs_created"]
            total_cancelled_jobs += result.get("jobs_cancelled", 0)
            total_rescheduled_jobs += result.get("jobs_rescheduled", 0)
            total_skipped_host_blocks += result["skipped_host_blocks"]
            total_skipped_not_reserved += result["skipped_not_reserved"]
            total_future_bookings += result.get("future_bookings", 0)
            missing_turnovers.extend(result.get("missing_turnovers", []))
            sources_synced.append(prop_ical.source or "unknown")

    # Update property sync timestamp
    prop.ical_last_synced_at = datetime.now(timezone.utc)

    # Safety-net: backfill scheduled_date for any Job that ended up null
    # despite being linked to an ICalEvent with a known checkout date.
    # _sync_ical_url sometimes lands jobs with null scheduled_date (under
    # investigation); this catches them so the Schedule view does not show
    # "Invalid Date".
    broken_jobs = (
        db.query(Job)
        .filter(
            Job.property_id == prop.id,
            Job.ical_event_id.isnot(None),
            Job.scheduled_date.is_(None),
            Job.status.notin_(("cancelled", "completed")),
        )
        .all()
    )
    backfilled_count = 0
    for j in broken_jobs:
        ev = db.query(ICalEvent).filter_by(id=j.ical_event_id).first()
        if ev and ev.checkout_date:
            j.scheduled_date = _to_date(ev.checkout_date)
            if not j.start_time:
                j.start_time = _to_time(prop.check_out_time or "10:00")
            backfilled_count += 1
    if backfilled_count > 0:
        log.info(f"[sync_property] safety-net backfilled scheduled_date on {backfilled_count} jobs for {prop.name}")
    db.commit()

    # Self-heal: ensure every upcoming turnover has a Google Calendar event
    # (catches ones created while Google was disconnected).
    gcal_backfilled = _backfill_turnover_gcal(db, prop)

    return {
        "property_id": prop.id,
        "property_name": prop.name,
        "events_seen": total_seen,
        "events_created": total_created_events,
        "jobs_created": total_created_jobs,
        "jobs_cancelled": total_cancelled_jobs,
        "jobs_rescheduled": total_rescheduled_jobs,
        "skipped_host_blocks": total_skipped_host_blocks,
        "skipped_not_reserved": total_skipped_not_reserved,
        "gcal_backfilled": gcal_backfilled,
        "sources_synced": sources_synced,
        "sync_errors": sync_errors,
        # Coverage: every future guest checkout should have an active turnover.
        # missing_turnovers is the safety-net — it should always be empty.
        "future_bookings": total_future_bookings,
        "missing_turnovers": missing_turnovers,
        "synced_at": prop.ical_last_synced_at.isoformat() if prop.ical_last_synced_at else None,
    }


