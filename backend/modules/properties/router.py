from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List

from database.db import get_db
from database.models import Property, ICalEvent, PropertyIcal
from integrations.ical_sync import sync_property
from modules.auth.router import require_role

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
    check_in_time: Optional[str] = None  # "14:00"
    check_out_time: Optional[str] = None  # "10:00"
    house_code: Optional[str] = None
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
    check_in_time: Optional[str] = None
    check_out_time: Optional[str] = None
    house_code: Optional[str] = None
    notes: Optional[str] = None
    active: Optional[bool] = None


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
        "check_in_time": p.check_in_time,
        "check_out_time": p.check_out_time,
        "house_code": p.house_code,
        "notes": p.notes,
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
                "last_synced_at": pi.last_synced_at.isoformat() if pi.last_synced_at else None,
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


@router.patch("/{property_id}")
def update_property(property_id: int, data: PropertyUpdate, db: Session = Depends(get_db)):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(prop, field, value)
    db.commit()
    db.refresh(prop)
    return prop_to_dict(prop)


@router.post("/{property_id}/sync")
def sync_ical(property_id: int, db: Session = Depends(get_db)):
    """Fetch the iCal feed and auto-create turnover jobs."""
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    result = sync_property(db, prop)
    if "error" in result:
        raise HTTPException(status_code=502, detail=result["error"])
    return result


@router.post("/sync-all")
def sync_all_ical(db: Session = Depends(get_db)):
    """Sync all active properties that have an iCal URL."""
    props = db.query(Property).filter(
        Property.active == True,
        Property.ical_url != None,
    ).all()
    results = []
    for prop in props:
        results.append(sync_property(db, prop))
    return {"synced": len(results), "results": results}


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


@router.delete("/{property_id}", status_code=204)
def delete_property(property_id: int, db: Session = Depends(get_db)):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    prop.active = False
    db.commit()


# Multiple iCal management endpoints

@router.post("/{property_id}/icals", status_code=201)
def add_ical_url(property_id: int, data: PropertyIcalSchema, db: Session = Depends(get_db)):
    """Add another iCal URL to a property (Airbnb, VRBO, etc)"""
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    ical = PropertyIcal(
        property_id=property_id,
        url=data.url,
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


@router.patch("/{property_id}/icals/{ical_id}")
def update_ical_url(property_id: int, ical_id: int, data: PropertyIcalSchema, db: Session = Depends(get_db)):
    """Update an iCal URL"""
    ical = db.query(PropertyIcal).filter(
        PropertyIcal.id == ical_id,
        PropertyIcal.property_id == property_id
    ).first()

    if not ical:
        raise HTTPException(status_code=404, detail="iCal not found")

    if data.url:
        ical.url = data.url
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


@router.delete("/{property_id}/icals/{ical_id}", status_code=204)
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
