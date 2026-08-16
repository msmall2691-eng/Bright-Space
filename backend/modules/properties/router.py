from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, and_, func
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel, field_validator
from typing import Optional, List
from datetime import datetime, timezone, timedelta
import re
import logging

from database.db import get_db
from database.models import Property, ICalEvent, PropertyIcal, Client, Job
from integrations.ical_sync import sync_property
from modules.auth.router import require_role, current_org_id
from utils.dates import business_today
from utils.address import combine_address

# A feed that hasn't synced cleanly in this long is loudly "stale" rather than
# quietly missing — auto-sync runs every 15 min by default (scheduler.py), so
# 24h is ~96 missed cycles: long enough to not flap on a transient blip, short
# enough that a truly dead feed doesn't sit hidden for days.
_ICAL_STALE_AFTER = timedelta(hours=24)


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
    turnover_rate: Optional[float] = None  # weekend piece rate per rental turnover ($)
    # Structured specs — pre-fillable from public property records via the
    # "look up specs" action, or entered by hand. NULL = unknown.
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None  # Float: half-baths (2½) must survive
    square_footage: Optional[int] = None
    year_built: Optional[int] = None
    custom_fields: Optional[dict] = {}


class PropertyUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    property_type: Optional[str] = None
    default_duration_hours: Optional[float] = None
    default_crew_size: Optional[int] = None
    access_notes: Optional[str] = None
    parking_notes: Optional[str] = None
    check_in_time: Optional[str] = None
    check_out_time: Optional[str] = None
    house_code: Optional[str] = None
    wifi_ssid: Optional[str] = None
    wifi_password: Optional[str] = None
    timezone: Optional[str] = None
    business_name: Optional[str] = None
    hours_of_operation: Optional[str] = None
    notes: Optional[str] = None
    turnover_rate: Optional[float] = None  # weekend piece rate per rental turnover ($)
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None
    square_footage: Optional[int] = None
    year_built: Optional[int] = None
    active: Optional[bool] = None
    checklist_template: Optional[list] = None
    custom_fields: Optional[dict] = None


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


def _property_ical_health(p: Property) -> Optional[str]:
    """Rolled-up per-property feed health for STR properties (Tier 3 roadmap:
    a dead feed should be loud, not something you find via an on-demand
    sweep). One of:
      - None       — not an STR property; health doesn't apply
      - "no_feed"  — STR property with zero active iCal feeds configured
      - "healthy"  — at least one active feed synced cleanly within
                     _ICAL_STALE_AFTER
      - "stale"    — every active feed is either failing or hasn't synced
                     recently enough to trust
    """
    if p.property_type != "str":
        return None
    active_feeds = [f for f in (p.property_icals or []) if f.active]
    if not active_feeds:
        return "no_feed"
    cutoff = datetime.now(timezone.utc) - _ICAL_STALE_AFTER
    for f in active_feeds:
        if f.last_sync_status == "ok" and f.last_synced_at:
            synced_at = f.last_synced_at
            if synced_at.tzinfo is None:
                synced_at = synced_at.replace(tzinfo=timezone.utc)
            if synced_at >= cutoff:
                return "healthy"
    return "stale"


def _turnovers_next_30d(db: Session, property_id: int) -> int:
    """Single-property turnover count for the next 30 days (Tier 3 roadmap's
    'N turnovers next 30d' indicator). See _turnovers_next_30d_bulk for the
    list-endpoint equivalent that avoids one query per property."""
    today = business_today()
    return (
        db.query(func.count(Job.id))
          .filter(
              Job.property_id == property_id,
              Job.job_type == "str_turnover",
              Job.status != "cancelled",
              Job.scheduled_date >= today,
              Job.scheduled_date <= today + timedelta(days=30),
          )
          .scalar() or 0
    )


def _turnovers_next_30d_bulk(db: Session, property_ids: list) -> dict:
    """{property_id: count} for every id in property_ids, in one query —
    used by the properties list endpoint instead of N single-property
    queries."""
    if not property_ids:
        return {}
    today = business_today()
    rows = (
        db.query(Job.property_id, func.count(Job.id))
          .filter(
              Job.property_id.in_(property_ids),
              Job.job_type == "str_turnover",
              Job.status != "cancelled",
              Job.scheduled_date >= today,
              Job.scheduled_date <= today + timedelta(days=30),
          )
          .group_by(Job.property_id)
          .all()
    )
    return dict(rows)


def prop_to_dict(p: Property, include_icals: bool = True, turnovers_next_30d: Optional[int] = None) -> dict:
    data = {
        "id": p.id,
        "client_id": p.client_id,
        "name": p.name,
        "address": p.address,
        "city": p.city,
        "state": p.state,
        "zip_code": p.zip_code,
        "property_type": p.property_type,
        "ical_last_synced_at": p.ical_last_synced_at.isoformat() if p.ical_last_synced_at else None,
        "default_duration_hours": p.default_duration_hours,
        "default_crew_size": getattr(p, 'default_crew_size', None),
        "access_notes": getattr(p, 'access_notes', None),
        "parking_notes": getattr(p, 'parking_notes', None),
        "check_in_time": p.check_in_time,
        "check_out_time": p.check_out_time,
        "house_code": p.house_code,
        "wifi_ssid": getattr(p, 'wifi_ssid', None),
        "wifi_password": getattr(p, 'wifi_password', None),
        "timezone": getattr(p, 'timezone', None),
        "business_name": getattr(p, 'business_name', None),
        "hours_of_operation": getattr(p, 'hours_of_operation', None),
        "turnover_rate": getattr(p, 'turnover_rate', None),
        "notes": p.notes,
        # Structured specs (enrichment Phase 1). Previously stored but never
        # surfaced — the columns existed since migration 025/056 yet the API
        # was blind to them, so a quote lookup's beds/baths/sqft were discarded.
        "bedrooms": getattr(p, 'bedrooms', None),
        "bathrooms": getattr(p, 'bathrooms', None),
        "square_footage": getattr(p, 'square_footage', None),
        "year_built": getattr(p, 'year_built', None),
        "checklist_template": getattr(p, 'checklist_template', None),
        "custom_fields": getattr(p, 'custom_fields', None) or {},
        "active": p.active,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "ical_health": _property_ical_health(p),
        "turnovers_next_30d": turnovers_next_30d,
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
                # Event count from the last known-good sync (migration 052 —
                # written by ical_sync's partial-fetch guard, so it's the
                # trusted baseline, not a possibly-truncated read). Surfaces
                # "what did this feed actually produce?" in the UI.
                "last_events_seen": pi.last_events_seen,
            }
            for pi in (p.property_icals or [])
        ]

    return data


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_properties(
    client_id: Optional[int] = None,
    property_type: Optional[str] = None,
    include_inactive: bool = False,  # archived properties stay hidden unless asked
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    # MT-2: scope to the caller's workspace; tolerate legacy NULL-org rows.
    q = (db.query(Property).options(joinedload(Property.property_icals))
         .filter(or_(Property.org_id == org_id, Property.org_id.is_(None))))
    if not include_inactive:
        q = q.filter(Property.active == True)
    if client_id:
        q = q.filter(Property.client_id == client_id)
    if property_type:
        q = q.filter(Property.property_type == property_type)
    props = q.order_by(Property.name).all()
    str_ids = [p.id for p in props if p.property_type == "str"]
    counts = _turnovers_next_30d_bulk(db, str_ids)
    return [
        prop_to_dict(p, turnovers_next_30d=(counts.get(p.id, 0) if p.property_type == "str" else None))
        for p in props
    ]


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_property(data: PropertyCreate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    d = data.model_dump()
    if not d.get("address"):
        d["address"] = ""
    # Normalize/validate property_type BEFORE it reaches the DB: the schema
    # accepted any string, so a caller passing a JOB type (e.g. 'str_turnover'
    # from the Schedule Job modal) sailed through Pydantic and died on
    # ck_properties_property_type as an HTTP 500 with no clue for the user.
    # Map the known job-type synonym, reject anything else as a clear 422.
    _pt = (d.get("property_type") or "residential").strip().lower()
    if _pt in ("str_turnover", "turnover", "rental"):
        _pt = "str"
    if _pt not in ("residential", "commercial", "str"):
        raise HTTPException(
            status_code=422,
            detail=f"property_type must be residential, commercial, or str (got '{d.get('property_type')}')",
        )
    d["property_type"] = _pt
    # Dedup guard: a property is uniquely a (client, normalized address) pair.
    # If this client already has a property at the same street+city+state+zip,
    # return it instead of creating a second row — so a double-submit or a
    # re-add of an address the client already has can't spawn a duplicate.
    if d.get("address"):
        from modules.intake.normalize import _property_key
        target = _property_key(d.get("address"), d.get("city"), d.get("state"), d.get("zip_code"))
        for p in db.query(Property).filter(Property.client_id == d["client_id"]).all():
            if _property_key(p.address, p.city, p.state, p.zip_code) == target:
                # Compute for real (same helper as the GETs) — this dedup path
                # returns an EXISTING property that may already have upcoming
                # turnovers, so a hardcoded 0 here lied to the caller.
                return prop_to_dict(
                    p,
                    turnovers_next_30d=(
                        _turnovers_next_30d(db, p.id) if p.property_type == "str" else None
                    ),
                )
    prop = Property(**d)
    prop.org_id = org_id  # MT-2: stamp the caller's workspace
    db.add(prop)
    db.commit()
    db.refresh(prop)
    # Same computation as GET /{id} (trivially 0 for a brand-new property, but
    # keeping the one helper means the create response can't drift from the
    # detail/list shape).
    n30 = _turnovers_next_30d(db, prop.id) if prop.property_type == "str" else None
    return prop_to_dict(prop, turnovers_next_30d=n30)


@router.get("/lookup-specs", dependencies=[Depends(require_role("admin", "manager"))])
def lookup_specs(
    address: str = Query(..., min_length=3, max_length=300),
    city: Optional[str] = Query(None, max_length=120),
    state: Optional[str] = Query(None, max_length=60),
    zip_code: Optional[str] = Query(None, max_length=20),
    db: Session = Depends(get_db),
):
    """Look up structured specs (sqft / beds / baths / year built) for an address
    via the configured provider (RentCast), to pre-fill the Add/Edit Property
    form. Returns {"enabled": bool, "specs": {...}|None}.

    Best-effort and non-blocking, mirroring the quote composer's
    /api/quotes/property-lookup: when the owner hasn't enabled enrichment, no key
    is set, or there's simply no match, `specs` is None and this never raises.
    Owner-gated by Settings → Property Photos & Data (property_enrichment_enabled
    + rentcast_api_key).

    Route order: defined before GET /{property_id} so this static path wins over
    the int-coerced parameterized route.

    NOTE: the provider's own `property_type` (e.g. "Single Family") is returned
    untouched for display only — callers must NOT use it to override BrightBase's
    residential | commercial | str classification, which is a human decision.
    """
    from services.property_media import enrichment_enabled, property_specs
    from modules.settings.router import get_setting
    if not enrichment_enabled(db):
        return {"enabled": False, "specs": None}
    # Compose the fullest address we can — RentCast matches far better with
    # city/state/zip than a bare street line. combine_address skips any component
    # already present in the street string (no doubled ", ME").
    full = combine_address(address, city, state, zip_code) or address.strip()
    return {"enabled": True, "specs": property_specs(full, get_setting(db, "rentcast_api_key"))}


@router.get("/all-ical-events", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_all_ical_events(
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Return all iCal booking events across the caller's properties (for the
    main calendar).

    Audit: this used to have no role gate and no org scoping — any signed-in
    user (or the shared API key) could list every property's bookings across
    tenants. Now: role-gated and joined through the property's org_id, keeping
    the legacy `org_id IS NULL` rows visible for pre-tenancy data.

    Route order matters — FastAPI matches in registration order, so this
    static path must sit above `/{property_id}` or the parameterized route
    swallows the URL and 422s on int coercion before this handler runs.
    """
    q = (
        db.query(ICalEvent, Property)
        .join(Property, ICalEvent.property_id == Property.id)
        .filter(or_(Property.org_id == org_id, Property.org_id.is_(None)))
    )
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


@router.get("/{property_id}", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_property(property_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """BB-SEC-11: this endpoint returns the full property dict — house_code,
    access_notes, wifi_password included — and had no role gate at all, so any
    authenticated cleaner could read every property's codes by id. Office roles
    only now (matches the list endpoint above); the crew app reads properties
    through /api/crew/*, which serves access details solely for the cleaner's
    own assigned jobs."""
    prop = db.query(Property).options(joinedload(Property.property_icals)).filter(
        Property.id == property_id,
        or_(Property.org_id == org_id, Property.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    n30 = _turnovers_next_30d(db, prop.id) if prop.property_type == "str" else None
    return prop_to_dict(prop, turnovers_next_30d=n30)


@router.patch("/{property_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_property(property_id: int, data: PropertyUpdate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    prop = db.query(Property).filter(
        Property.id == property_id,
        or_(Property.org_id == org_id, Property.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    # exclude_UNSET (not exclude_none): apply every field the client actually
    # sent, honoring an explicit null. exclude_none silently dropped nulls, so
    # clearing a populated field (e.g. blanking out bedrooms/sqft/year_built)
    # never persisted — the save looked successful and the old value came back
    # on reload. Fields the client omits stay untouched, so partial PATCHes still
    # work. (Codex review on #657.)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(prop, field, value)
    db.commit()
    db.refresh(prop)
    n30 = _turnovers_next_30d(db, prop.id) if prop.property_type == "str" else None
    return prop_to_dict(prop, turnovers_next_30d=n30)


@router.post("/{property_id}/sync", dependencies=[Depends(require_role("admin", "manager"))])
def sync_ical(property_id: int, db: Session = Depends(get_db)):
    """Fetch the iCal feed and auto-create turnover jobs."""
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    result = sync_property(db, prop)
    if "error" in result:
        log.warning(f"iCal sync failed for property {property_id}: {result.get('error')}")
        raise HTTPException(status_code=502, detail="Calendar sync failed — check the feed URL and try again.")
    return result


def _active_turnover_dates(db: Session, property_id: int) -> set:
    """ISO checkout dates of this property's active (non-cancelled), future,
    dated turnover jobs. Used for the rebuild before/after report."""
    from datetime import date as _date
    from database.models import Job
    today = business_today().isoformat()
    out = set()
    for j in db.query(Job).filter(
        Job.property_id == property_id,
        Job.job_type == "str_turnover",
        Job.status.notin_(["cancelled"]),
        Job.scheduled_date.isnot(None),
    ).all():
        d = j.scheduled_date.isoformat() if hasattr(j.scheduled_date, "isoformat") else str(j.scheduled_date)
        if d >= today:
            out.add(d)
    return out


@router.post("/{property_id}/rebuild-turnovers", dependencies=[Depends(require_role("admin", "manager"))])
def rebuild_turnovers(property_id: int, db: Session = Depends(get_db)):
    """Rebuild this property's turnovers from its calendar feeds — the safety net.

    Force-reconciles against the feeds (Google/iCal are the source of truth):
    recreates cancelled/deleted turnovers for still-active bookings, fixes
    stale/empty dates, and pushes changes to Google. Returns a clear before→after
    so you can trust nothing was missed. `still_missing` should be empty; if not,
    it lists the exact checkouts that couldn't be rebuilt (e.g. a failing feed).
    """
    from database.models import Job  # local import: keep module import surface small
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    before = _active_turnover_dates(db, property_id)
    result = sync_property(db, prop)
    if "error" in result:
        log.warning(f"iCal sync failed for property {property_id}: {result.get('error')}")
        raise HTTPException(status_code=502, detail="Calendar sync failed — check the feed URL and try again.")
    after = _active_turnover_dates(db, property_id)

    recovered = sorted(after - before)
    missing = result.get("missing_turnovers", [])
    return {
        "property_id": prop.id,
        "property_name": prop.name,
        "turnovers_before": len(before),
        "turnovers_after": len(after),
        "recovered_dates": recovered,
        "future_bookings": result.get("future_bookings", 0),
        "still_missing": missing,
        "ok": not missing and "error" not in result and not result.get("sync_errors"),
        "sync_errors": result.get("sync_errors", []),
    }


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
        log.warning(f"iCal sync failed for property {property_id}: {result.get('error')}")
        raise HTTPException(status_code=502, detail="Calendar sync failed — check the feed URL and try again.")
    return result


@router.post("/sync-all", dependencies=[Depends(require_role("admin", "manager"))])
def sync_all_ical(db: Session = Depends(get_db)):
    """Sync all active properties that have at least one active PropertyIcal feed."""
    # Dedupe on Property.id only, then load the rows. A `.distinct()` over full
    # Property rows fails on Postgres ("could not identify an equality operator
    # for type json") because Property has JSON columns.
    prop_ids = [
        row[0] for row in (
            db.query(Property.id)
            .join(PropertyIcal, PropertyIcal.property_id == Property.id)
            .filter(Property.active == True, PropertyIcal.active == True)
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

    today = business_today().isoformat()

    prop_ids = [
        row[0] for row in (
            db.query(Property.id)
            .join(PropertyIcal, PropertyIcal.property_id == Property.id)
            .filter(Property.active == True, PropertyIcal.active == True)
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
                # Per-feed failures surfaced even without inspecting each
                # PropertyIcal row, in case sync_property returned errors
                # before reaching the per-feed status writes.
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
    from integrations.ical_sync import _parse_date, _is_host_block
    from database.models import Job

    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(404, "Property not found")

    today = business_today().isoformat()
    prop_tz = prop.timezone or "America/New_York"

    feeds = []
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
            uid = str(comp.get("UID", ""))
            summary = str(comp.get("SUMMARY", ""))
            checkin = _parse_date(comp.get("DTSTART"), default_tz=prop_tz)
            checkout = _parse_date(comp.get("DTEND"), default_tz=prop_tz)
            # Same booking rule as the real sync (no "reserved"/"airbnb" allowlist).
            if _is_host_block(summary):
                decision = "skipped — host block / not available"
            elif not checkout:
                decision = "skipped — no checkout (DTEND) date"
            elif checkout and checkout < today:
                decision = "past"
            else:
                # Ground truth: report what's actually stored for this booking so a
                # missing turnover is explained in the decision the operator sees.
                stored = db.query(ICalEvent).filter_by(property_id=property_id, uid=uid).first()
                linked = None
                if stored and stored.job_id:
                    linked = db.query(Job).filter_by(id=stored.job_id).first()
                if stored and stored.job_id and linked is None:
                    decision = "linked turnover was DELETED — sync will recreate"
                elif linked and linked.status == "cancelled":
                    decision = "linked turnover is CANCELLED — sync will recreate"
                elif linked and linked.status == "completed":
                    decision = "turnover completed ✓"
                elif linked:
                    lj_date = (linked.scheduled_date.isoformat()
                               if hasattr(linked.scheduled_date, "isoformat")
                               else str(linked.scheduled_date)) if linked.scheduled_date else None
                    if lj_date != checkout:
                        decision = f"linked turnover dated {lj_date or 'EMPTY'} ≠ checkout — sync will fix"
                    else:
                        decision = "turnover exists ✓"
                elif checkout in existing:
                    decision = "turnover exists ✓"
                else:
                    decision = "would create turnover"
            info["events"].append({
                "summary": summary, "checkin": checkin, "checkout": checkout, "decision": decision,
            })
        info["events"].sort(key=lambda e: e.get("checkout") or "")
        out["feeds"].append(info)
    return out


@router.delete("/{property_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_property(property_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    prop = db.query(Property).filter(
        Property.id == property_id,
        or_(Property.org_id == org_id, Property.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
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
        # BB-MT-01: inherit the parent property's org — this was previously
        # left NULL and surfaced on every workspace's iCal listing.
        org_id=prop.org_id,
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
    """Infer correct property_type from STR-specific signals only.

    STR is inferred from an active PropertyIcal feed — that is the
    booking/turnover model. check_in_time/check_out_time are STR-only DATA,
    not a classification signal: residential and commercial properties use
    normal recurring scheduling, so a stray check_in_time on a non-STR
    property is cleaned up elsewhere (see the null-out step) rather than
    reclassifying it.
    """
    if prop.property_icals and any(p.active for p in prop.property_icals):
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
        # Default to the current type so check 4 has a value even when we skip
        # inference (commercial is a human-only classification we never auto-change).
        inferred_type = prop.property_type
        if prop.property_type != 'commercial':
            inferred_type = _infer_property_type(prop, db)
            if inferred_type != prop.property_type:
                would_change_type.append({
                    'id': prop.id,
                    'name': prop.name,
                    'old': prop.property_type,
                    'new': inferred_type,
                    'reason': 'inferred from PropertyIcal feed'
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

        # Check 5: Flag properties without a real client — either no client_id at
        # all, or a dangling reference to a client row that no longer exists.
        client_exists = prop.client_id and db.query(Client.id).filter(
            Client.id == prop.client_id
        ).first()
        if not client_exists:
            flagged_for_review.append({
                'id': prop.id,
                'name': prop.name,
                'reason': 'missing or dangling client_id'
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
