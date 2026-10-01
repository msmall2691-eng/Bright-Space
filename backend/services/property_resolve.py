"""Resolve (or create) the property a job/series belongs to — one definition.

Guardrail (BrightBase UI/workflow audit, Oct 2026): every job and every
recurring series must hang off a Property. A job/series born with no property is
the root of most of the duplicate/stale-visit mess — the series and its visits
float free of an address, so nothing dedups or reconciles against the house.

`create_job` already resolved a property inline; `create_schedule` did not, so a
recurring series could be created property-less. This is that logic in one place,
used by both, with one change from the old inline version: if the client has no
property AND no address on file, we now 422 instead of silently creating an
address-less property (an empty-address Property was itself a data problem).
"""
from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Client, Property


def _property_type_for(job_type):
    if job_type == "str_turnover":
        return "str"
    if job_type in ("residential", "commercial"):
        return job_type
    return "residential"


def resolve_property_for_client(
    db: Session, *, client_id: int, org_id=None,
    property_id=None, address=None, job_type=None,
) -> int:
    """Return the property id a job/series for this client should use.

    Order: a supplied property (validated to belong to this client) → the
    client's existing (oldest) property → a new property auto-created from the
    job's or the client's address. Raises HTTPException when none of these can
    produce a property:
      - 404 if a supplied property_id doesn't exist,
      - 400 if it belongs to a different client (the client/property drift the
        update path already refuses),
      - 422 if the client has no property and no address to create one from.
    """
    if property_id:
        q = db.query(Property).filter(Property.id == property_id)
        if org_id is not None:
            q = q.filter(or_(Property.org_id == org_id, Property.org_id.is_(None)))  # MT-2
        prop = q.first()
        if not prop:
            raise HTTPException(status_code=404, detail="Property not found.")
        if prop.client_id and prop.client_id != client_id:
            raise HTTPException(
                status_code=400,
                detail="That property belongs to a different client. Pick one of "
                       "this client's properties.",
            )
        return prop.id

    existing = (db.query(Property)
                .filter(Property.client_id == client_id)
                .order_by(Property.id.asc()).first())
    if existing:
        return existing.id

    client = db.query(Client).filter(Client.id == client_id).first()
    addr = (address or (getattr(client, "address", None) if client else "") or "").strip()
    if not addr:
        raise HTTPException(
            status_code=422,
            detail="This client has no property and no service address on file — "
                   "add a service address first so the work has a place to live.",
        )
    new_prop = Property(
        client_id=client_id,
        name=f"{client.name} — Main" if client and client.name else "Main location",
        address=addr,
        property_type=_property_type_for(job_type),
    )
    if hasattr(new_prop, "org_id"):
        new_prop.org_id = org_id
    db.add(new_prop)
    db.commit()
    db.refresh(new_prop)
    return new_prop.id
