from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List

from database.db import get_db
from modules.auth.router import require_role
from database.models import Job
from integrations.connecteam import ConnecteamAuthError, create_shift, delete_shift, get_employees
from utils.integration_log import log_integration_event as _log

router = APIRouter()


class DispatchError(BaseModel):
    employee_id: str
    error: str


class DispatchResponse(BaseModel):
    job_id: int
    dispatched: bool
    dispatched_count: int
    shift_ids: List[str]
    errors: List[DispatchError]


class UndispatchError(BaseModel):
    shift_id: str
    error: str


class UndispatchResponse(BaseModel):
    job_id: int
    errors: List[UndispatchError]


@router.get("/employees")
async def list_employees():
    """Fetch all employees from Connecteam."""
    try:
        return await get_employees()
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")


@router.post("/jobs/{job_id}/dispatch", response_model=DispatchResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def dispatch_job(job_id: int, db: Session = Depends(get_db)):
    """Push a job as shifts to Connecteam for all assigned cleaners."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.dispatched:
        raise HTTPException(status_code=400, detail="Job already dispatched")
    if not job.cleaner_ids:
        raise HTTPException(status_code=400, detail="No cleaners assigned to this job")

    shift_ids = []
    start_dt = f"{job.scheduled_date}T{job.start_time}:00"
    end_dt = f"{job.scheduled_date}T{job.end_time}:00"

    errors = []
    for employee_id in job.cleaner_ids:
        try:
            result = await create_shift(
                employee_id=employee_id,
                start_datetime=start_dt,
                end_datetime=end_dt,
                title=job.title,
                address=job.address,
                notes=job.notes,
            )
            sid = result.get("id") or result.get("shiftId", "")
            shift_ids.append(sid)
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="create", status="ok", external_id=sid, commit=False)
        except Exception as e:
            errors.append({"employee_id": employee_id, "error": str(e)})
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="create", status="failed", detail=str(e), commit=False)

    if shift_ids:
        job.dispatched = True
        job.connecteam_shift_ids = shift_ids
    db.commit()

    return {
        "job_id": job_id,
        "dispatched": bool(shift_ids),
        "dispatched_count": len(shift_ids),
        "shift_ids": shift_ids,
        "errors": errors,
    }


@router.delete("/jobs/{job_id}/dispatch", response_model=UndispatchResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def undispatch_job(job_id: int, db: Session = Depends(get_db)):
    """Remove Connecteam shifts for a job."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    errors = []
    for shift_id in (job.connecteam_shift_ids or []):
        try:
            await delete_shift(shift_id)
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="delete", status="ok", external_id=shift_id, commit=False)
        except Exception as e:
            errors.append({"shift_id": shift_id, "error": str(e)})
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="delete", status="failed", external_id=shift_id, detail=str(e), commit=False)

    job.dispatched = False
    job.connecteam_shift_ids = []
    db.commit()

    return {"job_id": job_id, "errors": errors}
