from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from datetime import datetime, timedelta

from database.db import get_db
from database.models import LeadIntake, Quote, Job, Invoice, Client

router = APIRouter()


@router.get("/board")
def get_work_board(db: Session = Depends(get_db)):
    """Get unified work board with all active pipeline stages."""
    now = datetime.utcnow()

    # Requests: open intakes (new, reviewed, quoted)
    intakes = db.query(LeadIntake).filter(
        LeadIntake.status.in_(["new", "reviewed", "quoted"])
    ).all()

    requests_data = []
    for intake in intakes:
        age_days = (now - intake.created_at).days if intake.created_at else 0
        client = db.query(Client).filter(Client.id == intake.client_id).first() if intake.client_id else None
        requests_data.append({
            "id": intake.id,
            "type": "request",
            "client_name": client.name if client else intake.name,
            "client_id": intake.client_id,
            "amount": None,
            "age_days": age_days,
            "status": intake.status,
            "source": intake.source,
            "service_type": intake.service_type,
        })

    # Quotes: draft and sent
    quotes = db.query(Quote).filter(
        Quote.status.in_(["draft", "sent"])
    ).all()

    quotes_data = []
    for quote in quotes:
        age_days = (now - quote.created_at).days if quote.created_at else 0
        client = db.query(Client).filter(Client.id == quote.client_id).first()
        quotes_data.append({
            "id": quote.id,
            "type": "quote",
            "client_name": client.name if client else f"Client #{quote.client_id}",
            "client_id": quote.client_id,
            "amount": float(quote.total) if quote.total else 0,
            "age_days": age_days,
            "status": quote.status,
            "quote_number": quote.quote_number,
            "service_type": quote.service_type,
        })

    # Jobs: scheduled and in_progress
    jobs = db.query(Job).filter(
        Job.status.in_(["scheduled", "in_progress"])
    ).all()

    jobs_data = []
    for job in jobs:
        age_days = (now - job.created_at).days if job.created_at else 0
        client = db.query(Client).filter(Client.id == job.client_id).first()
        jobs_data.append({
            "id": job.id,
            "type": "job",
            "client_name": client.name if client else f"Client #{job.client_id}",
            "client_id": job.client_id,
            "amount": None,
            "age_days": age_days,
            "status": job.status,
            "title": job.title,
            "scheduled_date": job.scheduled_date,
        })

    # Invoices: draft, sent, overdue
    invoices = db.query(Invoice).filter(
        Invoice.status.in_(["draft", "sent", "overdue"])
    ).all()

    invoices_data = []
    for invoice in invoices:
        age_days = (now - invoice.created_at).days if invoice.created_at else 0
        client = db.query(Client).filter(Client.id == invoice.client_id).first()
        invoices_data.append({
            "id": invoice.id,
            "type": "invoice",
            "client_name": client.name if client else f"Client #{invoice.client_id}",
            "client_id": invoice.client_id,
            "amount": float(invoice.total) if invoice.total else 0,
            "age_days": age_days,
            "status": invoice.status,
            "invoice_number": invoice.invoice_number,
            "due_date": invoice.due_date,
        })

    return {
        "requests": requests_data,
        "quotes": quotes_data,
        "jobs": jobs_data,
        "invoices": invoices_data,
    }
