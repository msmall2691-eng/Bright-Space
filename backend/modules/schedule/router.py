"""
Schedule week aggregate.

Originally returned five things in one round trip: visits, jobs, properties,
clients, and a coverage health check. After the Job/Visit unification (PR-C
of docs/job-visit-unification.md) occurrences are Jobs — the `visits` array
is derived from jobs so the pre-migration frontend still sees the same
top-level keys, and coverage is trivially healthy (nothing to drift against).

Note: the delegated functions are called directly (not over HTTP), so any
parameter whose default is a FastAPI ``Query(...)`` object must be passed
explicitly here — otherwise the function receives the sentinel, not the value.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database.db import get_db
from modules.auth.router import get_current_user, require_role, current_org_id
from modules.scheduling.router import get_jobs
from modules.properties.router import get_properties
from modules.clients.router import get_clients

router = APIRouter()


def _job_as_visit(job: dict) -> dict:
    """Wrap a Job dict in the pre-migration Visit shape (kept for one release
    so a stale Schedule.jsx bundle still renders while it reloads)."""
    return {
        **job,
        "job_id": job.get("id"),
        "scheduled_date": job.get("scheduled_date"),
        "start_time": job.get("start_time"),
        "end_time": job.get("end_time"),
        "cleaner_ids": job.get("cleaner_ids") or [],
        "status": job.get("status"),
    }


@router.get("/week", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def schedule_week(
    scheduled_date_from: str,
    scheduled_date_to: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    org_id: int = Depends(current_org_id),
):
    """Everything the Schedule page needs for one week, in a single response."""
    jobs = get_jobs(
        date_from=scheduled_date_from,
        date_to=scheduled_date_to,
        db=db, org_id=org_id,
    )
    return {
        # Visits are derived from jobs post-unification; the shape mirrors what
        # /api/visits used to emit so the FE fallback ({visits: [], jobs: [...]}
        # → jobs mapped to visit shape) keeps rendering unchanged.
        "visits": [_job_as_visit(j) for j in (jobs or [])],
        "jobs": jobs,
        "properties": get_properties(db=db, org_id=org_id),
        # limit/offset are Query() defaults — pass explicitly. 50 matches the
        # standalone /api/clients default the page used before.
        "clients": get_clients(limit=50, offset=0, db=db, org_id=org_id),
        # Coverage was "Job without Visit"; that can't happen anymore, so this
        # is always healthy. Kept in the response shape so the old FE tolerates it.
        "coverage": {
            "total_jobs": len(jobs or []),
            "jobs_without_visits": 0,
            "coverage_percent": 100,
            "healthy": True,
        },
    }
