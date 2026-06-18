"""
Dashboard aggregate endpoints.

The dashboard home screen previously fetched the full quotes list (limit=500),
the full intake list (limit=200) and the active-clients list purely to count
rows and sum totals on the client. This endpoint computes those numbers with
indexed SQL aggregates in one round trip — no large payloads, no client-side
counting. The dashboard still fetches row-level detail (invoices for AR aging,
jobs/visits/conversations for the schedule + attention list) separately, since
those need the actual records.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Quote, LeadIntake, Client
from modules.auth.router import require_role, current_org_id, resolve_org_id

router = APIRouter()


@router.get("/summary", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def dashboard_summary(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Pre-computed dashboard KPIs: quote funnel/pipeline, new leads, active clients.

    Mirrors the derivations the frontend used to run over the full lists:
      pipeline_value = Σ total where status in (sent, draft)
      awaiting       = sent + viewed          (quotes out for reply)
      changes        = changes_requested
      to_schedule    = accepted
      quoted         = sent + viewed + changes_requested  (funnel "Quoted")
      won            = converted                          (funnel "Won")
    """
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    # One grouped pass over quotes → count + total per status.
    rows = (
        db.query(Quote.status, func.count(Quote.id), func.coalesce(func.sum(Quote.total), 0.0))
        .filter(org_scope(Quote))
        .group_by(Quote.status)
        .all()
    )
    by_status = {status: (count, total) for status, count, total in rows}

    def n(*statuses):
        return sum(by_status.get(s, (0, 0.0))[0] for s in statuses)

    def amt(*statuses):
        return sum(by_status.get(s, (0, 0.0))[1] for s in statuses)

    new_leads = (
        db.query(func.count(LeadIntake.id))
        .filter(
            org_scope(LeadIntake),
            or_(LeadIntake.status.in_(("new", "received")), LeadIntake.status.is_(None)),
        )
        .scalar()
    ) or 0

    active_clients = (
        db.query(func.count(Client.id))
        .filter(org_scope(Client), Client.status == "active")
        .scalar()
    ) or 0

    return {
        "quotes": {
            "pipeline_value": round(amt("sent", "draft"), 2),
            "sent": n("sent"),
            "draft": n("draft"),
            "awaiting": n("sent", "viewed"),
            "changes": n("changes_requested"),
            "to_schedule": n("accepted"),
            "quoted": n("sent", "viewed", "changes_requested"),
            "accepted": n("accepted"),
            "won": n("converted"),
        },
        "new_leads": new_leads,
        "active_clients": active_clients,
    }
