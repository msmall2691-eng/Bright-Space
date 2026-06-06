from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, and_, func
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel, field_validator
from typing import Optional, List
import re
import logging

from database.db import get_db
from database.models import Property, ICalEvent, PropertyIcal, Client
from integrations.ical_sync import sync_property
from modules.auth.router import require_role


log = logging.getLogger(__name__)

router = APIRouter()


class PropertyCreate(BaseModel):
    client_id: int
    name: str
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    property_type: Optional[str] = "residential"  # residential | commercial | str
    ical_url: Optional[str] = None
    default_duration_hours: Optional[float] = 3.0
    default_crew_size: Optional[int] = None
    access_notes: Optional[str] = None
    parking_notes: Optional[str] = None
    check_in_time: Optional[str] = None  # "14:00"
    check_out_time: Optional[str] = None  # "10:00"
    house_code: Optional[str] = None
    timezone: Optional[str] = None
    business_name: Optional[str] = None
    hours_of_operation: Optional[str] = None
    notes: Optional[str] = None


class PropertyUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    property_type: Optional[str] = None
    ical_url: Optional[str] = None
    default_duration_hours: Optional[float] = None
    default_crew_size: Optional[int] = None
    access_notes: Optional[str] = None
    parking_notes: Optional[str] = None
    check_in_time: Optional[str] = None
    check_out_time: Optional[str] = None
    house_code: Optional[str] = None
    timezone: Optional[str] = None
    business_name: Optional[str] = None
    hours_of_operation: Optional[str] = None
    notes: Optional[str] = None
    active: Optional[bool] = None
    checklist_template: Optional[list] = None


class PropertyIcalSchema(BaseModel):
    id: Optional[int] = None
    url: str
    source: Optional[str] = None  # "airbnb", "vrbo", etc
    active: Optional[bool] = True
    checkout_time: Optional[str] = None
    duration_hours: Optional[float] = None
    house_code: Optional[str] = None
    access_links: Optional[dict] = None
    instructions: Optional[str] = None

    @field_validator('access_links', mode='before')
    @classmethod
    def _coerce_access_links(cls, v):
        """Frontend sends '' (empty string) when no access links are set.
        Coerce to None, or parse a JSON string into a dict if possible."""
        if v is None or v == '' or v == {} or v == []:
            return None
        if isinstance(v, dict):
            return v
        if isinstance(v, str):
            try:
                import json as _json
                parsed = _json.loads(v)
                return parsed if isinstance(parsed, dict) else None
            except (ValueError, TypeError):
                return None
        return None


def _normalize_ical_url(raw: str) -> str:
    """Validate + normalize an iCal feed URL. Accepts http(s) and webcal
    (which Airbnb/VRBO hand out); webcal is rewritten to https since that's
    what httpx fetches. Raises HTTPException(400) on anything unusable so the
    operator gets a clear message at save time instead of an opaque sync error
    hours later."""
    if not raw or not raw.strip():
        raise HTTPException(status_code=400, detail="iCal URL is required.")
    url = raw.strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    if not re.match(r"^https?://.+", url, re.IGNORECASE):
        raise HTTPException(
            status_code=400,
            detail="iCal URL must start with http://, https://, or webcal://.",
        )
    return url


def prop_to_dict(p: Property, include_icals: bool = True) -> dict:
    data = {
        "id": p.id,
        "client_id": p.client_id,
        "name": p.name,
        "address": p.address,
        "city": p.city,
        "state": p.state,
        "zip_code": p.zip_code,
        "property_type": p.property_type,
        "ical_url": p.ical_url,
        "ical_last_synced_at": p.ical_last_synced_at.isoformat() if p.ical_last_synced_at else None,
        "default_duration_hours": p.default_duration_hours,
        "default_crew_size": getattr(p, 'default_crew_size', None),
        "access_notes": getattr(p, 'access_notes', None),
        "parking_notes": getattr(p, 'parking_notes', None),
        "check_in_time": p.check_in_time,
        "check_out_time": p.check_out_time,
        "house_code": p.house_code,
        "timezone": getattr(p, 'timezone', None),
        "business_name": getattr(p, 'business_name', None),
        "hours_of_operation": getattr(p, 'hours_of_operation', None),
        "notes": p.notes,
        "checklist_template": getattr(p, 'checklist_template', None),
        "active": p.active,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }

    if include_icals:
        data["icals"] = [
            {
                "id": pi.id,
                "url": pi.url,
                "source": pi.source,
                "active": pi.active,
                "checkout_time": pi.checkout_time,
                "duration_hours": pi.duration_hours,
                "house_code": pi.house_code,
                "access_links": pi.access_links,
                "instructions": pi.instructions,
                # Sync observability — these fields exist on the model but
                # weren't surfaced, which is why operators couldn't tell
                # "is it actually syncing?" from the UI.
                "last_synced_at": pi.last_synced_at.isoformat() if pi.last_synced_at else None,
                "last_sync_status": pi.last_sync_status,
                "last_sync_error": pi.last_sync_error,
                "sync_retry_count": pi.sync_retry_count or 0,
            }
            for pi in (p.property_icals or [])
        ]

    return data


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_properties(
    client_id: Optional[int] = None,
    property_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Property).options(joinedload(Property.property_icals)).filter(Property.active == True)
    if client_id:
        q = q.filter(Property.client_id == client_id)
    if property_type:
        q = q.filter(Property.property_type == property_type)
    return [prop_to_dict(p) for p in q.order_by(Property.name).all()]


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_property(data: PropertyCreate, db: Session = Depends(get_db)):
    d = data.model_dump()
    if not d.get("address"):
        d["address"] = ""
    prop = Property(**d)
    db.add(prop)
    db.commit()
    db.refresh(prop)
    return prop_to_dict(prop)


@router.get("/{property_id}")
def get_property(property_id: int, db: Session = Depends(get_db)):
    prop = db.query(Property).options(joinedload(Property.property_icals)).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    return prop_to_dict(prop)


@router.patch("/{property_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_property(property_id: int, data: PropertyUpdate, db: Session = Depends(get_db)):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(prop, field, value)
    db.commit()
    db.refresh(prop)
    return prop_to_dict(prop)


@router.post("/{property_id}/sync", dependencies=[Depends(require_role("admin", "manager"))])
def sync_ical(property_id: int, db: Session = Depends(get_db)):
    """Fetch the iCal feed and auto-create turnover jobs."""
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    result = sync_property(db, prop)
    if "error" in result:
        raise HTTPException(status_code=502, detail=result["error"])
    return result


@router.post("/{property_id}/icals/{ical_id}/sync", dependencies=[Depends(require_role("admin", "manager"))])
def sync_single_ical(property_id: int, ical_id: int, db: Session = Depends(get_db)):
    """Re-sync a single iCal feed — lets staff retry one failing feed without
    re-running every feed on the property."""
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    ical = db.query(PropertyIcal).filter(
        PropertyIcal.id == ical_id,
        PropertyIcal.property_id == property_id,
    ).first()
    if not ical:
        raise HTTPException(status_code=404, detail="iCal not found")
    result = sync_property(db, prop, only_ical_id=ical_id)
    if "error" in result:
        raise HTTPException(status_code=502, detail=result["error"])
    return result


@router.post("/sync-all", dependencies=[Depends(require_role("admin", "manager"))])
def sync_all_ical(db: Session = Depends(get_db)):
    """Sync all active properties that have a feed (legacy ical_url OR a
    PropertyIcal row). Previously this matched only ical_url, so properties
    linked via the multi-feed UI were silently skipped."""
    # Dedupe on Property.id only, then load the rows. A `.distinct()` over full
    # Property rows fails on Postgres ("could not identify an equality operator
    # for type json") because Property has JSON columns.
    prop_ids = [
        row[0] for row in (
            db.query(Property.id)
            .outerjoin(PropertyIcal, PropertyIcal.property_id == Property.id)
            .filter(
                Property.active == True,
                or_(
                    Property.ical_url.isnot(None),
                    and_(PropertyIcal.id.isnot(None), PropertyIcal.active == True),
                ),
            )
            .distinct()
            .all()
        )
    ]
    props = db.query(Property).filter(Property.id.in_(prop_ids)).all() if prop_ids else []
    results = []
    for prop in props:
        results.append(sync_property(db, prop))
    return {"synced": len(results), "results": results}


@router.post("/turnover-sweep", dependencies=[Depends(require_role("admin", "manager"))])
def turnover_sweep(db: Session = Depends(get_db)):
    """Re-sync every property that has a feed, then report per-property whether
    every expected turnover exists and is on Google Calendar — so the whole
    portfolio can be trusted at a glance, not just one property.

    For each property: expected = future reservation checkouts in the feed
    (from stored iCal events), scheduled = future turnover jobs, on_google =
    those with a calendar event. Flags missing dates (booking but no job) and
    jobs not yet on Google."""
    from datetime import date
    from database.models import Job, ICalEvent

    today = date.today().isoformat()

    prop_ids = [
        row[0] for row in (
            db.query(Property.id)
            .outerjoin(PropertyIcal, PropertyIcal.property_id == Property.id)
            .filter(
                Property.active == True,
                or_(
                    Property.ical_url.isnot(None),
                    and_(PropertyIcal.id.isnot(None), PropertyIcal.active == True),
                ),
            )
            .distinct()
            .all()
        )
    ]
    props = db.query(Property).filter(Property.id.in_(prop_ids)).all() if prop_ids else []

    def _d(x):
        return x.isoformat() if hasattr(x, "isoformat") else (str(x) if x else None)

    report = []
    totals = {"properties": 0, "expected": 0, "scheduled": 0, "on_google": 0, "missing": 0, "not_on_google": 0}
    for prop in props:
        sync_error = None
        try:
            result = sync_property(db, prop)
            # sync_property fails *soft*: when a feed is unreachable/unparsable it
            # records a failed status on the PropertyIcal row and returns instead
            # of throwing. If we only trusted the try/except we'd declare the
            # property healthy off stale ICalEvent rows even though its feed never
            # refreshed (Codex review). So check both the returned error and the
            # per-feed sync status.
            if isinstance(result, dict) and result.get("error"):
                sync_error = str(result["error"])[:200]
            elif isinstance(result, dict) and result.get("sync_errors"):
                # Per-source failures — notably the legacy ical_url, which has no
                # PropertyIcal row for the feed-status check below to inspect
                # (Codex review follow-up).
                errs = result["sync_errors"]
                detail = "; ".join(f"{e.get('source', 'feed')}: {e.get('error', '')}" for e in errs[:3])
                sync_error = f"feed sync failed ({detail})"
        except Exception as e:
            log.warning(f"turnover-sweep sync failed for property {prop.id}: {e}")
            sync_error = "sync failed"

        if not sync_error:
            failed_feeds = [
                pi for pi in (prop.property_icals or [])
                if getattr(pi, "active", True) and pi.last_sync_status in ("failed", "retrying")
            ]
            if failed_feeds:
                detail = "; ".join(
                    f"{pi.source or 'feed'}: {pi.last_sync_error or pi.last_sync_status}"
                    for pi in failed_feeds[:3]
                )
                sync_error = f"feed sync failed ({detail})"

        expected_dates = {
            _d(e.checkout_date)
            for e in db.query(ICalEvent).filter(
                ICalEvent.property_id == prop.id,
                ICalEvent.checkout_date >= today,
            ).all()
            if getattr(e, "event_type", "reservation") == "reservation" and e.checkout_date
        }
        jobs = db.query(Job).filter(
            Job.property_id == prop.id,
            Job.job_type == "str_turnover",
            Job.status.notin_(["cancelled"]),
            Job.scheduled_date.isnot(None),
            Job.scheduled_date >= today,
        ).all()
        scheduled_dates = {_d(j.scheduled_date) for j in jobs}
        on_google = sum(1 for j in jobs if j.gcal_event_id)
        missing = sorted(d for d in expected_dates if d not in scheduled_dates)
        not_on_google = len(jobs) - on_google

        report.append({
            "property_id": prop.id,
            "property": prop.name,
            "expected": len(expected_dates),
            "scheduled": len(jobs),
            "on_google": on_google,
            "missing_dates": missing,
            "not_on_google": not_on_google,
            "sync_error": sync_error,
            "ok": not missing and not_on_google == 0 and not sync_error,
        })
        totals["properties"] += 1
        totals["expected"] += len(expected_dates)
        totals["scheduled"] += len(jobs)
        totals["on_google"] += on_google
        totals["missing"] += len(missing)
        totals["not_on_google"] += not_on_google

    report.sort(key=lambda r: (r["ok"], r["property"] or ""))  # problems first
    return {"totals": totals, "properties": report}


@router.get("/{property_id}/ical-events")
def get_ical_events(
    property_id: int,
    start: Optional[str] = None,   # YYYY-MM-DD
    end: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return iCal booking events for a property (for calendar display)."""
    q = db.query(ICalEvent).filter(ICalEvent.property_id == property_id)
    if start:
        q = q.filter(ICalEvent.checkout_date >= start)
    if end:
        q = q.filter(ICalEvent.checkin_date <= end)
    return [
        {
            "id": e.id,
            "uid": e.uid,
            "summary": e.summary,
            "event_type": getattr(e, "event_type", "reservation"),
            "checkin_date": e.checkin_date,
            "checkout_date": e.checkout_date,
            "job_id": e.job_id,
        }
        for e in q.order_by(ICalEvent.checkin_date).all()
    ]


@router.get("/{property_id}/ical-preview", dependencies=[Depends(require_role("admin", "manager"))])
def ical_preview(property_id: int, db: Session = Depends(get_db)):
    """Live diagnostic: fetch the property's iCal feed(s) and show, per booking,
    what the turnover sync would decide — so you can see exactly why a given
    checkout did or didn't become a turnover (e.g. a missing June 26)."""
    import httpx
    from datetime import date
    from icalendar import Calendar
    from integrations.ical_sync import _parse_date
    from database.models import Job

    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(404, "Property not found")

    BLOCK_WORDS = ("not available", "blocked", "unavailable", "maintenance", "owner")
    today = date.today().isoformat()
    prop_tz = prop.timezone or "America/New_York"

    feeds = []
    if prop.ical_url:
        feeds.append(("legacy", prop.ical_url))
    for pi in (prop.property_icals or []):
        if pi.active and pi.url:
            feeds.append((pi.source or "feed", pi.url))

    existing = {
        (j.scheduled_date.isoformat() if hasattr(j.scheduled_date, "isoformat") else str(j.scheduled_date))
        for j in db.query(Job).filter(
            Job.property_id == property_id,
            Job.job_type == "str_turnover",
            Job.status != "cancelled",
        ).all()
        if j.scheduled_date
    }

    out = {"property": prop.name, "today": today, "feeds": []}
    for label, url in feeds:
        info = {"source": label, "error": None, "events": []}
        try:
            with httpx.Client(timeout=15) as client:
                r = client.get(url)
                r.raise_for_status()
                cal = Calendar.from_ical(r.content)
        except Exception as e:
            log.warning(f"ical-preview fetch/parse failed for property {property_id} ({label}): {e}")
            info["error"] = "Could not fetch or parse this feed."
            out["feeds"].append(info)
            continue
        for comp in cal.walk():
            if comp.name != "VEVENT":
                continue
            summary = str(comp.get("SUMMARY", ""))
            low = summary.lower()
            checkin = _parse_date(comp.get("DTSTART"), default_tz=prop_tz)
            checkout = _parse_date(comp.get("DTEND"), default_tz=prop_tz)
            if any(w in low for w in BLOCK_WORDS):
                decision = "skipped — host block / not available"
            elif "reserved" not in low and "airbnb" not in low:
                decision = "skipped — not a reservation"
            elif checkout and checkout < today:
                decision = "past"
            elif checkout and checkout in existing:
                decision = "turnover exists ✓"
            else:
                decision = "would create turnover"
            info["events"].append({
                "summary": summary, "checkin": checkin, "checkout": checkout, "decision": decision,
            })
        info["events"].sort(key=lambda e: e.get("checkout") or "")
        out["feeds"].append(info)
    return out


@router.get("/all-ical-events")
def get_all_ical_events(
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return all iCal booking events across all properties (for the main calendar)."""
    q = db.query(ICalEvent, Property).join(Property, ICalEvent.property_id == Property.id)
    if start:
        q = q.filter(ICalEvent.checkout_date >= start)
    if end:
        q = q.filter(ICalEvent.checkin_date <= end)
    results = []
    for event, prop in q.order_by(ICalEvent.checkin_date).all():
        results.append({
            "id": event.id,
            "uid": event.uid,
            "summary": event.summary,
            "event_type": getattr(event, "event_type", "reservation"),
            "checkin_date": event.checkin_date,
            "checkout_date": event.checkout_date,
            "job_id": event.job_id,
            "property_id": prop.id,
            "property_name": prop.name,
        })
    return results


@router.delete("/{property_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_property(property_id: int, db: Session = Depends(get_db)):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    prop.active = False
    db.commit()


# Multiple iCal management endpoints

@router.post("/{property_id}/icals", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def add_ical_url(property_id: int, data: PropertyIcalSchema, db: Session = Depends(get_db)):
    """Add another iCal URL to a property (Airbnb, VRBO, etc)"""
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    url = _normalize_ical_url(data.url)
    # Reject a feed already linked to this property (case-insensitive) so we
    # don't create redundant rows that double-sync the same bookings.
    dup = db.query(PropertyIcal).filter(
        PropertyIcal.property_id == property_id,
        func.lower(PropertyIcal.url) == url.lower(),
    ).first()
    if dup:
        raise HTTPException(
            status_code=409,
            detail="This iCal feed is already linked to this property.",
        )

    ical = PropertyIcal(
        property_id=property_id,
        url=url,
        source=data.source,
        active=data.active if data.active is not None else True,
        checkout_time=data.checkout_time,
        duration_hours=data.duration_hours,
        house_code=data.house_code,
        access_links=data.access_links,
        instructions=data.instructions,
    )
    db.add(ical)
    db.commit()
    db.refresh(ical)

    return {
        "id": ical.id,
        "url": ical.url,
        "source": ical.source,
        "active": ical.active,
        "checkout_time": ical.checkout_time,
        "duration_hours": ical.duration_hours,
        "house_code": ical.house_code,
        "access_links": ical.access_links,
        "instructions": ical.instructions,
    }


@router.patch("/{property_id}/icals/{ical_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_ical_url(property_id: int, ical_id: int, data: PropertyIcalSchema, db: Session = Depends(get_db)):
    """Update an iCal URL"""
    ical = db.query(PropertyIcal).filter(
        PropertyIcal.id == ical_id,
        PropertyIcal.property_id == property_id
    ).first()

    if not ical:
        raise HTTPException(status_code=404, detail="iCal not found")

    if data.url:
        ical.url = _normalize_ical_url(data.url)
    if data.source:
        ical.source = data.source
    if data.active is not None:
        ical.active = data.active
    if data.checkout_time is not None:
        ical.checkout_time = data.checkout_time
    if data.duration_hours is not None:
        ical.duration_hours = data.duration_hours
    if data.house_code is not None:
        ical.house_code = data.house_code
    if data.access_links is not None:
        ical.access_links = data.access_links
    if data.instructions is not None:
        ical.instructions = data.instructions

    db.commit()
    db.refresh(ical)

    return {
        "id": ical.id,
        "url": ical.url,
        "source": ical.source,
        "active": ical.active,
        "checkout_time": ical.checkout_time,
        "duration_hours": ical.duration_hours,
        "house_code": ical.house_code,
        "access_links": ical.access_links,
        "instructions": ical.instructions,
    }


@router.delete("/{property_id}/icals/{ical_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def remove_ical_url(property_id: int, ical_id: int, db: Session = Depends(get_db)):
    """Remove an iCal URL from a property"""
    ical = db.query(PropertyIcal).filter(
        PropertyIcal.id == ical_id,
        PropertyIcal.property_id == property_id
    ).first()

    if not ical:
        raise HTTPException(status_code=404, detail="iCal not found")

    db.delete(ical)
    db.commit()


# Admin utilities

STATE_ABBREVIATIONS = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC'
}


def _infer_property_type(prop: Property, db: Session) -> str:
    """Infer correct property_type based on iCal, check-in time, client notes."""
    # If has ical_url or PropertyIcal entries → definitely STR
    if prop.ical_url:
        return 'str'

    if prop.property_icals and any(p.active for p in prop.property_icals):
        return 'str'

    # If check_in_time is set → STR
    if prop.check_in_time:
        return 'str'

    # Check client notes for business indicators
    client = db.query(Client).filter(Client.id == prop.client_id).first()
    if client and client.notes:
        notes_lower = client.notes.lower()
        if any(word in notes_lower for word in ['business', 'commercial', 'office', 'retail', 'restaurant']):
            return 'commercial'

    # Default to residential
    return 'residential'


def _normalize_property_name(prop: Property) -> Optional[str]:
    """If name is a service description, use address instead."""
    if not prop.name:
        return None

    service_keywords = ['monthly', 'weekly', 'biweekly', 'residential', 'commercial', 'str', 'turnover', 'cleaning', 'clean']
    name_lower = prop.name.lower()

    # Check if name contains service keywords
    contains_service_keyword = any(keyword in name_lower for keyword in service_keywords)

    if contains_service_keyword and prop.address:
        # Use address as the new name
        return prop.address

    # Otherwise keep as is
    return None


def _normalize_city_state(city: Optional[str], state: Optional[str]) -> tuple:
    """Title case city, uppercase state."""
    new_city = None
    new_state = None

    if city:
        # Title case: "scarborough" → "Scarborough", "south portland" → "South Portland"
        new_city = ' '.join(word.capitalize() for word in city.strip().split())

    if state:
        # Handle full state name or abbreviation
        state_clean = state.strip().lower()
        if state_clean in STATE_ABBREVIATIONS:
            new_state = STATE_ABBREVIATIONS[state_clean]
        elif len(state_clean) == 2:
            new_state = state_clean.upper()
        else:
            # Try to match 2-letter abbreviation
            abbr = state_clean[:2].upper()
            if any(abbr == v for v in STATE_ABBREVIATIONS.values()):
                new_state = abbr
            else:
                new_state = state.strip().upper()

    return new_city, new_state


@router.post("/admin/normalize-properties", dependencies=[Depends(require_role("admin"))])
def normalize_properties(
    dry_run: bool = Query(True),
    db: Session = Depends(get_db),
):
    """
    Admin endpoint to normalize property data.

    - Infer correct property_type from iCal, check-in time, client notes
    - Normalize property names (remove service descriptions, use address)
    - Normalize city/state casing
    - NULL-OUT STR-only fields on non-STR properties
    - Flag properties without clients

    Returns stats about proposed/applied changes.
    """
    props = db.query(Property).filter(Property.active == True).all()

    would_change_type = []
    would_rename = []
    would_fix_city_state = []
    would_null_str_fields = []
    flagged_for_review = []

    for prop in props:
        # Check 1: Infer property_type
        # Guard: never auto-change commercial → anything else (commercial is human-only classification)
        if prop.property_type != 'commercial':
            inferred_type = _infer_property_type(prop, db)
            if inferred_type != prop.property_type:
                would_change_type.append({
                    'id': prop.id,
                    'name': prop.name,
                    'old': prop.property_type,
                    'new': inferred_type,
                    'reason': 'inferred from ical_url, PropertyIcal, or check_in_time'
                })

        # Check 2: Normalize property name
        new_name = _normalize_property_name(prop)
        if new_name and new_name != prop.name:
            would_rename.append({
                'id': prop.id,
                'old_name': prop.name,
                'new_name': new_name,
                'reason': 'service description keyword detected'
            })

        # Check 3: Normalize city/state
        new_city, new_state = _normalize_city_state(prop.city, prop.state)
        if (new_city and new_city != prop.city) or (new_state and new_state != prop.state):
            would_fix_city_state.append({
                'id': prop.id,
                'name': prop.name,
                'before': {'city': prop.city, 'state': prop.state},
                'after': {'city': new_city or prop.city, 'state': new_state or prop.state}
            })

        # Check 4: NULL-OUT STR-only fields on non-STR
        current_type = inferred_type if inferred_type != prop.property_type else prop.property_type
        if current_type != 'str':
            str_fields = []
            if prop.check_in_time:
                str_fields.append('check_in_time')
            if prop.check_out_time:
                str_fields.append('check_out_time')
            if prop.house_code:
                str_fields.append('house_code')

            if str_fields:
                would_null_str_fields.append({
                    'id': prop.id,
                    'name': prop.name,
                    'fields': str_fields
                })

        # Check 5: Flag properties without clients
        if not prop.client_id:
            flagged_for_review.append({
                'id': prop.id,
                'name': prop.name,
                'reason': 'missing client_id'
            })

    # If not dry run, apply the changes
    if not dry_run:
        for change in would_change_type:
            prop = db.query(Property).filter(Property.id == change['id']).first()
            if prop:
                prop.property_type = change['new']
                log.info(f"Changed property {prop.id} type from {change['old']} to {change['new']}")

        for change in would_rename:
            prop = db.query(Property).filter(Property.id == change['id']).first()
            if prop:
                prop.name = change['new_name']
                log.info(f"Renamed property {prop.id} from '{change['old_name']}' to '{change['new_name']}'")

        for change in would_fix_city_state:
            prop = db.query(Property).filter(Property.id == change['id']).first()
            if prop:
                new_city, new_state = _normalize_city_state(prop.city, prop.state)
                if new_city:
                    prop.city = new_city
                if new_state:
                    prop.state = new_state
                log.info(f"Fixed city/state for property {prop.id}")

        for change in would_null_str_fields:
            prop = db.query(Property).filter(Property.id == change['id']).first()
            if prop:
                if 'check_in_time' in change['fields']:
                    prop.check_in_time = None
                if 'check_out_time' in change['fields']:
                    prop.check_out_time = None
                if 'house_code' in change['fields']:
                    prop.house_code = None
                log.info(f"Nulled STR fields for property {prop.id}: {change['fields']}")

        db.commit()

    return {
        'dry_run': dry_run,
        'properties_checked': len(props),
        'would_change_type': would_change_type,
        'would_rename': would_rename,
        'would_fix_city_state': would_fix_city_state,
        'would_null_str_fields': would_null_str_fields,
        'flagged_for_review': flagged_for_review,
    }
