from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional
from database.db import get_db
from database.models import Activity

router = APIRouter()


def activity_to_dict(a):
    return {
        "id": a.id,
        "client_id": a.client_id,
        "opportunity_id": a.opportunity_id,
        "job_id": a.job_id,
        "message_id": a.message_id,
        "actor": a.actor,
        "activity_type": a.activity_type,
        "summary": a.summary,
        "extra_data": a.extra_data,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


@router.get("")
def list_activities(
    client_id: Optional[int] = None,
    opportunity_id: Optional[int] = None,
    activity_type: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(Activity)
    if client_id:
        q = q.filter(Activity.client_id == client_id)
    if opportunity_id:
        q = q.filter(Activity.opportunity_id == opportunity_id)
    if activity_type:
        q = q.filter(Activity.activity_type == activity_type)
    return [activity_to_dict(a) for a in q.order_by(Activity.created_at.desc()).limit(limit).all()]
