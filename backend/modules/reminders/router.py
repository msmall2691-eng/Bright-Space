"""
Reminders module.
- Send 24hr SMS reminders for tomorrow's jobs
- Download .ics invite for any job
- Send .ics via SMS link (Twilio)
- Trigger Google Calendar event creation for a job
"""

import os
from datetime import date, timedelta
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Job, Client
from integrations.ics_generator import generate_job_ics
from integrations.twilio_client import send_sms
from integrations.google_calendar import create_event, update_event
from modules.comms.router import normalize_phone

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


# ── .ics download ──────────────────────────────────────────────────────────

@router.get("/jobs/{job_id}/invite.ics")
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


# ── SMS reminder ───────────────────────────────────────────────────────────

@router.post("/jobs/{job_id}/sms-reminder")
def send_job_reminder(job_id: int, db: Session = Depends(get_db)):
    """Send a 24hr SMS reminder to the client for a specific job."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    client = db.query(Client).filter(Client.id == job.client_id).first()
    if not client or not client.phone:
        raise HTTPException(status_code=400, detail="Client has no phone number")

    msg = (
        f"Hi {client.name.split()[0]}! Just a reminder — "
        f"The Maine Cleaning Co. will be at {job.address or 'your property'} "
        f"tomorrow, {job.scheduled_date}, at {job.start_time}. "
        f"Reply STOP to unsubscribe."
    )
    try:
        result = send_sms(to=normalize_phone(client.phone), body=msg)
        job.sms_reminder_sent = True
        db.commit()
        return {"sent": True, "to": client.phone, "sid": result.get("sid")}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Twilio error: {e}")


@router.post("/send-daily-reminders")
def send_daily_reminders(db: Session = Depends(get_db)):
    """
    Send SMS reminders for all jobs scheduled tomorrow that haven't been reminded yet.
    Call this daily (manually or via a cron/scheduler).
    """
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    jobs = db.query(Job).filter(
        Job.scheduled_date == tomorrow,
        Job.status == "scheduled",
        Job.sms_reminder_sent == False,
    ).all()

    sent = []
    errors = []
    for job in jobs:
        client = db.query(Client).filter(Client.id == job.client_id).first()
        if not client or not client.phone:
            continue
        try:
            msg = (
                f"Hi {client.name.split()[0]}! Reminder — "
                f"The Maine Cleaning Co. visits tomorrow, {job.scheduled_date}, at {job.start_time}. "
                f"Address: {job.address or 'your property'}. "
                f"Reply STOP to unsubscribe."
            )
            send_sms(to=normalize_phone(client.phone), body=msg)
            job.sms_reminder_sent = True
            sent.append({"job_id": job.id, "client": client.name, "phone": client.phone})
        except Exception as e:
            errors.append({"job_id": job.id, "error": str(e)})
    db.commit()
    return {"date": tomorrow, "sent": len(sent), "details": sent, "errors": errors}


# ── Google Calendar ────────────────────────────────────────────────────────

@router.post("/jobs/{job_id}/gcal")
def push_to_gcal(job_id: int, db: Session = Depends(get_db)):
    """Create or update this job's Google Calendar event."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    client = db.query(Client).filter(Client.id == job.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    event_id = create_event(_job_dict(job), _client_dict(client))
    if not event_id:
        raise HTTPException(status_code=502, detail="Failed to create Google Calendar event. Run auth_google.py first.")

    job.calendar_invite_sent = True
    db.commit()
    return {"job_id": job_id, "gcal_event_id": event_id, "client_invited": bool(client.email)}


@router.post("/push-upcoming-to-gcal")
def push_upcoming_to_gcal(db: Session = Depends(get_db)):
    """Push all upcoming scheduled jobs that don't have a calendar invite yet."""
    today = date.today().isoformat()
    jobs = db.query(Job).filter(
        Job.scheduled_date >= today,
        Job.status == "scheduled",
        Job.calendar_invite_sent == False,
    ).all()

    pushed = []
    errors = []
    for job in jobs:
        client = db.query(Client).filter(Client.id == job.client_id).first()
        if not client:
            continue
        event_id = create_event(_job_dict(job), _client_dict(client))
        if event_id:
            job.calendar_invite_sent = True
            pushed.append({"job_id": job.id, "title": job.title, "date": job.scheduled_date})
        else:
            errors.append({"job_id": job.id, "error": "GCal failed"})
    db.commit()
    return {"pushed": len(pushed), "details": pushed, "errors": errors}
