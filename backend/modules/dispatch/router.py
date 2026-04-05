from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List

from database.db import get_db
from database.models import Job
from integrations.connecteam import create_shift, delete_shift, get_employees

router = APIRouter()


@router.get("/employees")
async def list_employees():
    """Fetch all employees from Connecteam."""
    try:
        return await get_employees()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")


@router.post("/jobs/{job_id}/dispatch")
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
            shift_ids.append(result.get("id") or result.get("shiftId", ""))
        except Exception as e:
            errors.append({"employee_id": employee_id, "error": str(e)})

    if shift_ids:
        job.dispatched = 1
        job.connecteam_shift_ids = shift_ids
        db.commit()

    return {
        "job_id": job_id,
        "dispatched": len(shift_ids),
        "shift_ids": shift_ids,
        "errors": errors,
    }


@router.delete("/jobs/{job_id}/dispatch")
async def undispatch_job(job_id: int, db: Session = Depends(get_db)):
    """Remove Connecteam shifts for a job."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    errors = []
    for shift_id in (job.connecteam_shift_ids or []):
        try:
            await delete_shift(shift_id)
        except Exception as e:
            errors.append({"shift_id": shift_id, "error": str(e)})

    job.dispatched = 0
    job.connecteam_shift_ids = []
    db.commit()

    return {"job_id": job_id, "errors": errors}
