from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from database.db import get_db
from database.models import Opportunity, Client, Activity, Quote, Invoice, Job, Message

router = APIRouter()


class OpportunityCreate(BaseModel):
    client_id: int
    title: str
    stage: str = "new"
    amount: Optional[float] = None
    close_date: Optional[str] = None
    probability: Optional[int] = None
    service_type: Optional[str] = None
    owner: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = {}


class OpportunityUpdate(BaseModel):
    title: Optional[str] = None
    stage: Optional[str] = None
    amount: Optional[float] = None
    close_date: Optional[str] = None
    probability: Optional[int] = None
    service_type: Optional[str] = None
    owner: Optional[str] = None
    lost_reason: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = None


def opp_to_dict(o):
    return {
        "id": o.id,
        "client_id": o.client_id,
        "client_name": o.client.name if o.client else None,
        "title": o.title,
        "stage": o.stage,
        "amount": o.amount,
        "close_date": o.close_date,
        "probability": o.probability,
        "service_type": o.service_type,
        "owner": o.owner,
        "lost_reason": o.lost_reason,
        "notes": o.notes,
        "custom_fields": o.custom_fields or {},
        "quotes_count": len(o.quotes) if hasattr(o, 'quotes') else 0,
        "invoices_count": len(o.invoices) if hasattr(o, 'invoices') else 0,
        "jobs_count": len(o.jobs) if hasattr(o, 'jobs') else 0,
        "messages_count": len(o.messages) if hasattr(o, 'messages') else 0,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "updated_at": o.updated_at.isoformat() if o.updated_at else None,
    }


def log_activity(db, *, client_id=None, opportunity_id=None, actor=None,
                 activity_type, summary=None, extra_data=None):
    a = Activity(
        client_id=client_id,
        opportunity_id=opportunity_id,
        actor=actor,
        activity_type=activity_type,
        summary=summary,
        extra_data=extra_data or {},
    )
    db.add(a)


@router.get("")
def list_opportunities(
    stage: Optional[str] = None,
    client_id: Optional[int] = None,
    owner: Optional[str] = None,
    service_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Opportunity)
    if stage:
        q = q.filter(Opportunity.stage == stage)
    if client_id:
        q = q.filter(Opportunity.client_id == client_id)
    if owner:
        q = q.filter(Opportunity.owner == owner)
    if service_type:
        q = q.filter(Opportunity.service_type == service_type)
    return [opp_to_dict(o) for o in q.order_by(Opportunity.created_at.desc()).all()]


@router.get("/summary")
def opportunity_summary(db: Session = Depends(get_db)):
    opps = db.query(Opportunity).all()
    stages = {}
    total_value = 0
    weighted_value = 0
    for o in opps:
        s = o.stage or "new"
        if s not in stages:
            stages[s] = {"count": 0, "value": 0}
        stages[s]["count"] += 1
        stages[s]["value"] += o.amount or 0
        total_value += o.amount or 0
        weighted_value += (o.amount or 0) * (o.probability or 0) / 100
    return {
        "stages": stages,
        "total_count": len(opps),
        "total_value": total_value,
        "weighted_value": round(weighted_value, 2),
    }


@router.get("/{opp_id}")
def get_opportunity(opp_id: int, db: Session = Depends(get_db)):
    o = db.query(Opportunity).options(
        joinedload(Opportunity.client),
        joinedload(Opportunity.quotes),
        joinedload(Opportunity.invoices),
        joinedload(Opportunity.jobs),
        joinedload(Opportunity.messages),
    ).filter(Opportunity.id == opp_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return opp_to_dict(o)


@router.get("/{opp_id}/details")
def get_opportunity_details(opp_id: int, db: Session = Depends(get_db)):
    """Get full opportunity details with all related entities and timeline."""
    o = db.query(Opportunity).options(
        joinedload(Opportunity.client),
        joinedload(Opportunity.quotes),
        joinedload(Opportunity.invoices),
        joinedload(Opportunity.jobs),
        joinedload(Opportunity.messages),
        joinedload(Opportunity.activities),
    ).filter(Opportunity.id == opp_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Opportunity not found")

    return {
        **opp_to_dict(o),
        "quotes": [
            {
                "id": q.id,
                "quote_number": q.quote_number,
                "status": q.status,
                "total": q.total,
                "created_at": q.created_at.isoformat() if q.created_at else None,
            }
            for q in o.quotes
        ],
        "invoices": [
            {
                "id": inv.id,
                "invoice_number": inv.invoice_number,
                "status": inv.status,
                "total": inv.total,
                "created_at": inv.created_at.isoformat() if inv.created_at else None,
            }
            for inv in o.invoices
        ],
        "jobs": [
            {
                "id": j.id,
                "title": j.title,
                "status": j.status,
                "scheduled_date": j.scheduled_date,
                "created_at": j.created_at.isoformat() if j.created_at else None,
            }
            for j in o.jobs
        ],
        "timeline": [
            {
                "id": a.id,
                "activity_type": a.activity_type,
                "summary": a.summary,
                "actor": a.actor,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in o.activities
        ],
    }


@router.post("", status_code=201)
def create_opportunity(data: OpportunityCreate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == data.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    o = Opportunity(
        client_id=data.client_id,
        title=data.title,
        stage=data.stage,
        amount=data.amount,
        close_date=data.close_date,
        probability=data.probability,
        service_type=data.service_type,
        owner=data.owner,
        notes=data.notes,
        custom_fields=data.custom_fields or {},
    )
    db.add(o)
    db.flush()

    if client.lifecycle_stage in (None, "new"):
        client.lifecycle_stage = "opportunity"

    log_activity(
        db,
        client_id=data.client_id,
        opportunity_id=o.id,
        actor=data.owner,
        activity_type="opportunity_created",
        summary=f"Created opportunity: {data.title}",
        extra_data={"stage": data.stage, "amount": data.amount},
    )
    db.commit()
    db.refresh(o)
    return opp_to_dict(o)


@router.patch("/{opp_id}")
def update_opportunity(opp_id: int, data: OpportunityUpdate, db: Session = Depends(get_db)):
    o = db.query(Opportunity).filter(Opportunity.id == opp_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Opportunity not found")

    old_stage = o.stage
    updates = data.model_dump(exclude_none=True)
    for k, v in updates.items():
        setattr(o, k, v)

    if "stage" in updates and updates["stage"] != old_stage:
        log_activity(
            db,
            client_id=o.client_id,
            opportunity_id=o.id,
            actor=data.owner or o.owner,
            activity_type="opportunity_stage_changed",
            summary=f"Stage changed: {old_stage} → {updates['stage']}",
            extra_data={"old_stage": old_stage, "new_stage": updates["stage"]},
        )
        if updates["stage"] == "won" and o.client:
            o.client.lifecycle_stage = "customer"
            o.client.status = "active"
            log_activity(
                db,
                client_id=o.client_id,
                opportunity_id=o.id,
                actor=data.owner or o.owner,
                activity_type="opportunity_won",
                summary=f"Opportunity won: {o.title}",
            )

    db.commit()
    db.refresh(o)
    return opp_to_dict(o)


@router.delete("/{opp_id}", status_code=204)
def delete_opportunity(opp_id: int, db: Session = Depends(get_db)):
    o = db.query(Opportunity).filter(Opportunity.id == opp_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    db.delete(o)
    db.commit()
