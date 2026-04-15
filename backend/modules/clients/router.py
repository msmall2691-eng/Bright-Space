from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, date
import io
import re

from database.db import get_db
from database.models import Client, Property, Job, ICalEvent

router = APIRouter()


def _derive_name(first: Optional[str], last: Optional[str], fallback: str) -> str:
    """Return 'First Last' when both parts are set, else fallback to existing name."""
    parts = " ".join(p for p in [first, last] if p and p.strip())
    return parts if parts else fallback


class ClientCreate(BaseModel):
    name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    billing_address: Optional[str] = None
    billing_city: Optional[str] = None
    billing_state: Optional[str] = None
    billing_zip: Optional[str] = None
    status: Optional[str] = "lead"
    notes: Optional[str] = None
    source: Optional[str] = None
    custom_fields: Optional[dict] = {}


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    billing_address: Optional[str] = None
    billing_city: Optional[str] = None
    billing_state: Optional[str] = None
    billing_zip: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    source: Optional[str] = None
    custom_fields: Optional[dict] = None


def client_to_dict(c: Client) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "first_name": c.first_name or "",
        "last_name": c.last_name or "",
        "email": c.email,
        "phone": c.phone,
        "address": c.address,
        "city": c.city,
        "state": c.state,
        "zip_code": c.zip_code,
        "billing_address": c.billing_address or "",
        "billing_city": c.billing_city or "",
        "billing_state": c.billing_state or "",
        "billing_zip": c.billing_zip or "",
        "status": c.status,
        "notes": c.notes,
        "source": c.source,
        "custom_fields": c.custom_fields or {},
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


@router.get("")
def get_clients(status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(Client)
    if status:
        q = q.filter(Client.status == status)
    return [client_to_dict(c) for c in q.order_by(Client.created_at.desc()).all()]


@router.post("", status_code=201)
def create_client(data: ClientCreate, db: Session = Depends(get_db)):
    payload = data.model_dump()
    payload["name"] = _derive_name(payload.get("first_name"), payload.get("last_name"), payload.get("name") or "")
    if not payload["name"]:
        raise HTTPException(status_code=422, detail="name or first_name required")
    client = Client(**payload)
    db.add(client)
    db.commit()
    db.refresh(client)
    return client_to_dict(client)


@router.get("/{client_id}")
def get_client(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client_to_dict(client)


@router.get("/{client_id}/profile")
def get_client_profile(client_id: int, db: Session = Depends(get_db)):
    """
    Get client's full profile including properties, upcoming/past visits, and GCal sync status.
    """
    client = db.query(Client).options(
        joinedload(Client.properties).joinedload(Property.ical_events),
        joinedload(Client.jobs)
    ).filter(Client.id == client_id).first()

    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    # Build base client dict
    profile = client_to_dict(client)

    # Add properties
    properties_data = []
    for prop in client.properties:
        properties_data.append({
            "id": prop.id,
            "name": prop.name,
            "address": prop.address,
            "ical_url": prop.ical_url,
            "type": prop.property_type,
        })
    profile["properties"] = properties_data

    # Split jobs into upcoming and past
    today = date.today().isoformat()
    upcoming_jobs = []
    past_jobs = []

    for job in client.jobs:
        # Skip cancelled jobs in upcoming
        if job.scheduled_date and job.scheduled_date >= today and job.status != "cancelled":
            upcoming_jobs.append(job)
        elif job.scheduled_date and job.scheduled_date < today:
            past_jobs.append(job)

    # Sort upcoming ascending, past descending
    upcoming_jobs.sort(key=lambda j: (j.scheduled_date, j.start_time or ""))
    past_jobs.sort(key=lambda j: (j.scheduled_date, j.start_time or ""), reverse=True)

    # Build visit data
    def visit_to_dict(j: Job) -> dict:
        property_name = ""
        if j.property:
            property_name = j.property.name
        return {
            "id": j.id,
            "title": j.title,
            "scheduled_date": j.scheduled_date,
            "start_time": j.start_time,
            "end_time": j.end_time,
            "status": j.status,
            "job_type": j.job_type or "residential",
            "property_name": property_name,
            "gcal_event_id": j.gcal_event_id,
            "calendar_invite_sent": j.calendar_invite_sent,
            "address": j.address,
        }

    profile["upcoming_visits"] = [visit_to_dict(j) for j in upcoming_jobs]
    profile["past_visits"] = [visit_to_dict(j) for j in past_jobs]

    # Calculate visit stats
    total_jobs = len(client.jobs)
    completed_jobs = sum(1 for j in client.jobs if j.status == "completed")
    upcoming_count = len(upcoming_jobs)
    cancelled_count = sum(1 for j in client.jobs if j.status == "cancelled")
    gcal_synced = sum(1 for j in client.jobs if j.gcal_event_id)
    invites_sent = sum(1 for j in client.jobs if j.calendar_invite_sent)

    profile["visit_stats"] = {
        "total": total_jobs,
        "completed": completed_jobs,
        "upcoming": upcoming_count,
        "cancelled": cancelled_count,
        "gcal_synced": gcal_synced,
        "invites_sent": invites_sent,
    }

    return profile


@router.patch("/{client_id}")
def update_client(client_id: int, data: ClientUpdate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    updates = data.model_dump(exclude_none=True)
    for field, value in updates.items():
        setattr(client, field, value)
    # Re-derive name if first/last were updated
    if "first_name" in updates or "last_name" in updates:
        derived = _derive_name(client.first_name, client.last_name, client.name)
        if derived:
            client.name = derived
    db.commit()
    db.refresh(client)
    return client_to_dict(client)


@router.delete("/{client_id}", status_code=204)
def delete_client(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    db.delete(client)
    db.commit()


def _parse_address(raw: str):
    """Parse 'Street, City, State ZIP' into components. Best-effort."""
    if not raw:
        return {"address": "", "city": "", "state": "", "zip_code": ""}
    raw = raw.strip()
    # Extract zip
    zip_match = re.search(r'\b(\d{5})\b', raw)
    zip_code = zip_match.group(1) if zip_match else ""
    if zip_match:
        raw = raw[:zip_match.start()].strip().rstrip(",").strip()
    # Extract state (2-letter at end or 'Maine'/'ME')
    state_match = re.search(r',?\s*(Maine|ME)\s*$', raw, re.IGNORECASE)
    state = "ME" if state_match else ""
    if state_match:
        raw = raw[:state_match.start()].strip()
    # Remaining: "Street, City" â split on last comma
    parts = [p.strip() for p in raw.rsplit(",", 1)]
    if len(parts) == 2:
        return {"address": parts[0], "city": parts[1], "state": state, "zip_code": zip_code}
    return {"address": parts[0], "city": "", "state": state, "zip_code": zip_code}


@router.post("/cleanup")
def cleanup_clients(db: Session = Depends(get_db)):
    """
    Data cleanup endpoint: audit clients, backfill first/last names,
    flag SMS placeholders, and identify test records.
    Does NOT delete anything â returns a report + applies safe fixes.
    """
    clients = db.query(Client).all()
    report = {
        "total": len(clients),
        "names_backfilled": 0,
        "sms_placeholders": [],
        "test_records": [],
        "missing_email": 0,
        "missing_phone": 0,
        "fixes_applied": [],
    }

    TEST_PATTERNS = {"test", "asdf", "sample", "demo", "xxx"}

    for c in clients:
        # 1. Backfill first_name / last_name from name if not set
        if c.name and (not c.first_name and not c.last_name):
            parts = c.name.strip().split()
            if len(parts) >= 2 and not c.name.startswith("+"):
                c.first_name = parts[0]
                c.last_name = " ".join(parts[1:])
                report["names_backfilled"] += 1
                report["fixes_applied"].append(
                    f"Client #{c.id} '{c.name}': set first_name='{c.first_name}', last_name='{c.last_name}'"
                )
            elif len(parts) == 1 and not c.name.startswith("+"):
                c.first_name = parts[0]
                report["names_backfilled"] += 1
                report["fixes_applied"].append(
                    f"Client #{c.id} '{c.name}': set first_name='{c.first_name}'"
                )

        # 2. Flag SMS placeholders (name looks like a phone number)
        if c.name and (c.name.startswith("+") or c.name.replace("-", "").replace("(", "").replace(")", "").replace(" ", "").isdigit()):
            report["sms_placeholders"].append({
                "id": c.id, "name": c.name, "phone": c.phone, "status": c.status
            })

        # 3. Flag test/junk records
        if c.name and any(t in c.name.lower() for t in TEST_PATTERNS):
            report["test_records"].append({
                "id": c.id, "name": c.name, "status": c.status
            })

        # 4. Count missing contact info
        if not c.email:
            report["missing_email"] += 1
        if not c.phone:
            report["missing_phone"] += 1

    db.commit()
    return report


@router.post("/import-xlsx")
async def import_clients_xlsx(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import clients from an Excel (.xlsx) file exported from Connecteam or similar."""
    try:
        import openpyxl
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl not installed on server")

    content = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(content))
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return {"added": 0, "skipped": 0, "errors": []}

    headers = [str(h).strip() if h else "" for h in rows[0]]

    # Support both "Client Name" and "name" column headers
    def col(row, *names):
        for n in names:
            if n in headers:
                v = row[headers.index(n)]
                return str(v).strip() if v else ""
        return ""

    SKIP_NAMES = {"storage unit", "miscellaneous", "sandra"}
    existing = {c.name.lower() for c in db.query(Client).all()}

    added, skipped, errors = 0, 0, []
    seen_in_file = set()

    for row in rows[1:]:
        name = col(row, "Client Name", "name")
        if not name or name.lower() in SKIP_NAMES:
            continue
        if name.lower() in seen_in_file:
            continue
        seen_in_file.add(name.lower())

        if name.lower() in existing:
            skipped += 1
            continue

        raw_addr = col(row, "Address", "address")
        parsed = _parse_address(raw_addr)

        try:
            client = Client(
                name=name,
                address=parsed["address"] or None,
                city=parsed["city"] or None,
                state=parsed["state"] or None,
                zip_code=parsed["zip_code"] or None,
                status="active",
                source="xlsx_import",
            )
            db.add(client)
            existing.add(name.lower())
            added += 1
        except Exception as e:
            errors.append({"name": name, "error": str(e)})

    db.commit()
    return {"added": added, "skipped": skipped, "errors": errors}
