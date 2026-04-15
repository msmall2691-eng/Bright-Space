from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import io
import re

from database.db import get_db
from database.models import Client
from utils.contacts import normalize_phone

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
    payload["phone"] = normalize_phone(payload.get("phone"))
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


@router.patch("/{client_id}")
def update_client(client_id: int, data: ClientUpdate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    updates = data.model_dump(exclude_none=True)
    if "phone" in updates:
        updates["phone"] = normalize_phone(updates.get("phone"))
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
    # Remaining: "Street, City" — split on last comma
    parts = [p.strip() for p in raw.rsplit(",", 1)]
    if len(parts) == 2:
        return {"address": parts[0], "city": parts[1], "state": state, "zip_code": zip_code}
    return {"address": parts[0], "city": "", "state": state, "zip_code": zip_code}


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
