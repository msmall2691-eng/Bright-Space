"""
Gmail Inbox API Router
Fetches inbox, matches senders to clients, creates leads from unknown contacts.
"""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from database.db import get_db
from database.models import Client
from integrations.gmail_inbox import fetch_inbox, fetch_email_by_id
import logging

logger = logging.getLogger(__name__)
router = APIRouter()


def _match_email_to_client(email_addr: str, db: Session):
    """Match an email address to an existing client record."""
    if not email_addr:
        return None
    return db.query(Client).filter(
        Client.email.ilike(email_addr.strip().lower())
    ).first()


@router.get("/inbox")
def gmail_inbox(
    max_results: int = Query(30, ge=1, le=100),
    skip_automated: bool = Query(True),
    db: Session = Depends(get_db),
):
    """
    Fetch Gmail inbox and auto-match senders to existing clients.
    Non-automated emails from unknown senders are flagged as potential leads.
    """
    emails = fetch_inbox(max_results=max_results, skip_automated=skip_automated)

    client_cache = {}
    for em in emails:
        addr = em["from_email"]
        if addr not in client_cache:
            c = _match_email_to_client(addr, db)
            client_cache[addr] = (
                {"id": c.id, "name": c.name, "status": c.status} if c else None
            )
        em["client"] = client_cache[addr]
        em["is_known_contact"] = client_cache[addr] is not None

    total = len(emails)
    linked = sum(1 for e in emails if e["is_known_contact"])

    return {
        "emails": emails,
        "summary": {
            "total": total,
            "linked": linked,
            "unlinked": total - linked,
            "unread": sum(1 for e in emails if not e.get("is_read")),
        },
    }


@router.get("/message/{email_id}")
def gmail_message(email_id: str, db: Session = Depends(get_db)):
    """Fetch a single email with full body + client match."""
    em = fetch_email_by_id(email_id)
    if not em:
        raise HTTPException(404, "Email not found")
    c = _match_email_to_client(em["from_email"], db)
    em["client"] = {"id": c.id, "name": c.name, "status": c.status} if c else None
    em["is_known_contact"] = c is not None
    return em


@router.post("/create-lead")
def create_lead_from_email(
    from_name: str = Query(...),
    from_email: str = Query(...),
    db: Session = Depends(get_db),
):
    """Create a new client (status=lead) from an email sender."""
    existing = _match_email_to_client(from_email, db)
    if existing:
        return {"status": "exists", "client": {"id": existing.id, "name": existing.name}}

    parts = from_name.strip().split(" ", 1)
    new_client = Client(
        name=from_name.strip() or from_email,
        first_name=parts[0] if parts else from_name,
        last_name=parts[1] if len(parts) > 1 else "",
        email=from_email.lower(),
        status="lead",
        source="email",
        notes="Auto-created from Gmail inbox",
    )
    db.add(new_client)
    db.commit()
    db.refresh(new_client)

    logger.info(f"Lead created from email: {from_name} <{from_email}> -> #{new_client.id}")
    return {"status": "created", "client": {"id": new_client.id, "name": new_client.name}}


@router.post("/link-client")
def link_email_to_client(
    from_email: str = Query(...),
    client_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """Link an email address to an existing client by updating their email field."""
    client = db.query(Client).get(client_id)
    if not client:
        raise HTTPException(404, "Client not found")
    client.email = from_email.lower()
    db.commit()
    return {"status": "linked", "client": {"id": client.id, "name": client.name}}
