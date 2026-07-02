"""
Reminders module: download the .ics calendar invite for a job.

Historically this module also carried SMS-reminder and Google-Calendar-push
endpoints (send-job-reminder, send-daily-reminders, push-to-gcal,
push-upcoming-to-gcal). All four were removed after they went unused for
the entire life of the app — SMS reminders run via Twilio inside the send
flow and gcal is driven by the scheduler tick + inline `/api/jobs/*` routes.
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Job, Client
from integrations.ics_generator import generate_job_ics
from modules.auth.router import require_role

router = APIRouter()


def _job_dict(j: Job) -> dict:
    return {
        "id": j.id, "title": j.title, "job_type": j.job_type or "residential",
        "scheduled_date": j.scheduled_date, "start_time": j.start_time,
        "end_time": j.end_time, "address": j.address, "notes": j.notes,
        "calendar_invite_sent": j.calendar_invite_sent,
        "sms_reminder_sent": j.sms_reminder_sent,
    }


def _client_dict(c: Client) -> dict:
    return {"id": c.id, "name": c.name, "email": c.email, "phone": c.phone}


@router.get("/jobs/{job_id}/invite.ics", dependencies=[Depends(require_role("admin", "manager"))])
def download_ics(job_id: int, db: Session = Depends(get_db)):
    """Download the .ics calendar invite for a job."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    client = db.query(Client).filter(Client.id == job.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    ics_bytes = generate_job_ics(_job_dict(job), _client_dict(client))
    return Response(
        content=ics_bytes,
        media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="cleaning-{job_id}.ics"'},
    )
