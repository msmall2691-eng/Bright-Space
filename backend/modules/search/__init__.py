"""Global cross-entity search.

Powers the header search / Cmd+/ command palette so staff can jump to any
client, property, invoice, or job from one box instead of hunting through each
list page (none of which shared a search before). Read-only; results carry a
``path`` the frontend navigates to.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Client, Property, Invoice, Job
from modules.auth.router import require_role

logger = logging.getLogger(__name__)
router = APIRouter()


def _like(term: str) -> str:
    return f"%{term.lower()}%"


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def global_search(
    q: str = Query(..., min_length=1, description="Search term"),
    limit: int = Query(8, le=25, description="Max results per entity type"),
    db: Session = Depends(get_db),
):
    """Search clients, properties, invoices, and jobs by name/number/contact.

    Returns a flat list of {type, id, title, subtitle, path} grouped-friendly
    results. Each type is capped at ``limit`` so one noisy entity can't crowd
    out the others.
    """
    term = (q or "").strip()
    if not term:
        return {"query": q, "results": []}
    needle = _like(term)
    results = []

    # ── Clients ──
    clients = (
        db.query(Client)
        .filter(or_(
            func.lower(Client.name).like(needle),
            func.lower(Client.email).like(needle),
            func.lower(Client.phone).like(needle),
        ))
        .limit(limit)
        .all()
    )
    for c in clients:
        subtitle = c.email or c.phone or (c.status or "")
        results.append({
            "type": "client", "id": c.id, "title": c.name or "Unnamed client",
            "subtitle": subtitle, "path": f"/clients/{c.id}",
        })

    # ── Properties ──
    properties = (
        db.query(Property)
        .filter(or_(
            func.lower(Property.name).like(needle),
            func.lower(Property.address).like(needle),
            func.lower(Property.city).like(needle),
        ))
        .limit(limit)
        .all()
    )
    for p in properties:
        results.append({
            "type": "property", "id": p.id, "title": p.name or p.address or "Property",
            "subtitle": p.address or p.city or "", "path": f"/properties/{p.id}",
        })

    # ── Invoices ──
    invoices = (
        db.query(Invoice)
        .outerjoin(Client, Invoice.client_id == Client.id)
        .filter(or_(
            func.lower(Invoice.invoice_number).like(needle),
            func.lower(Client.name).like(needle),
        ))
        .limit(limit)
        .all()
    )
    for inv in invoices:
        client_name = inv.client.name if inv.client else ""
        results.append({
            "type": "invoice", "id": inv.id,
            "title": inv.invoice_number or f"Invoice #{inv.id}",
            "subtitle": f"{client_name} · ${inv.total or 0:,.2f} · {inv.status or ''}".strip(" ·"),
            "path": "/invoicing",
        })

    # ── Jobs ──
    jobs = (
        db.query(Job)
        .outerjoin(Client, Job.client_id == Client.id)
        .filter(or_(
            func.lower(Job.title).like(needle),
            func.lower(Job.address).like(needle),
            func.lower(Client.name).like(needle),
        ))
        .order_by(Job.scheduled_date.desc().nullslast()
                  if hasattr(Job.scheduled_date.desc(), "nullslast")
                  else Job.scheduled_date.desc())
        .limit(limit)
        .all()
    )
    for j in jobs:
        when = j.scheduled_date.isoformat() if j.scheduled_date else "unscheduled"
        results.append({
            "type": "job", "id": j.id, "title": j.title or "Job",
            "subtitle": f"{when} · {j.status or ''}".strip(" ·"),
            "path": "/schedule",
        })

    return {"query": term, "count": len(results), "results": results}
