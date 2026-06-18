"""
Schedule week aggregate.

The calendar fired five parallel calls on every week change — visits (the week
range), all jobs, all properties, all clients and the coverage health check.
This endpoint returns all of it in one round trip by delegating to the existing
endpoint functions, so the response shapes are byte-for-byte identical to the
standalone routes — only the round-trip count changes.

Note: the delegated functions are called directly (not over HTTP), so any
parameter whose default is a FastAPI ``Query(...)`` object must be passed
explicitly here — otherwise the function receives the sentinel, not the value.
``get_clients`` is the only such case (limit/offset).
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database.db import get_db
from modules.auth.router import get_current_user, require_role, current_org_id
from modules.scheduling.visits_router import get_visits, check_visits_coverage
from modules.scheduling.router import get_jobs
from modules.properties.router import get_properties
from modules.clients.router import get_clients

router = APIRouter()


@router.get("/week", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def schedule_week(
    scheduled_date_from: str,
    scheduled_date_to: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    org_id: int = Depends(current_org_id),
):
    """Everything the Schedule page needs for one week, in a single response."""
    visits = get_visits(
        scheduled_date_from=scheduled_date_from,
        scheduled_date_to=scheduled_date_to,
        limit=500, offset=0,
        db=db, current_user=current_user, org_id=org_id,
    )
    return {
        # get_visits returns {items, total, ...}; the page only wants the rows.
        "visits": visits.get("items", []) if isinstance(visits, dict) else visits,
        "jobs": get_jobs(db=db, org_id=org_id),
        "properties": get_properties(db=db, org_id=org_id),
        # limit/offset are Query() defaults — pass explicitly. 50 matches the
        # standalone /api/clients default the page used before.
        "clients": get_clients(limit=50, offset=0, db=db, org_id=org_id),
        "coverage": check_visits_coverage(db=db),
    }
