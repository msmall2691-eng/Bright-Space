"""Read API for the integration audit log (§5.5 of the April audit).

Surfaces the IntegrationEvent rows written by ``utils.integration_log`` so the
operator can confirm — without grepping server logs — whether a job's Google
Calendar event or a quote's email/SMS actually went out, and why a failure
happened. Read-only and admin-gated; rows are written by the actions themselves.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional

from database.db import get_db
from database.models import IntegrationEvent
from modules.auth.router import require_role

router = APIRouter()


def _event_to_dict(e: IntegrationEvent) -> dict:
    return {
        "id": e.id,
        "entity_type": e.entity_type,
        "entity_id": e.entity_id,
        "provider": e.provider,
        "action": e.action,
        "status": e.status,
        "external_id": e.external_id,
        "error_message": e.error_message,
        "error_code": e.error_code,
        "request_payload": e.request_payload,
        "response_payload": e.response_payload,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def list_integration_events(
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    provider: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """List integration events, newest first. Filterable by entity/provider/status."""
    q = db.query(IntegrationEvent)
    if entity_type:
        q = q.filter(IntegrationEvent.entity_type == entity_type)
    if entity_id is not None:
        q = q.filter(IntegrationEvent.entity_id == entity_id)
    if provider:
        q = q.filter(IntegrationEvent.provider == provider)
    if status:
        q = q.filter(IntegrationEvent.status == status)
    rows = (
        q.order_by(IntegrationEvent.created_at.desc(), IntegrationEvent.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [_event_to_dict(e) for e in rows]
