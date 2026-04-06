"""
Background scheduler for automated cleaning operations.

Runs these tasks on a recurring basis:
  1. iCal sync — every 15 min — pulls Airbnb/VRBO feeds, auto-creates turnover jobs
  2. Recurring job generation — daily at 2 AM — keeps the rolling job pipeline full
  3. Daily SMS reminders — daily at 9 AM — texts clients about tomorrow's jobs

Google Calendar is event-driven (not polled):
  - Job create → immediate GCal push
  - Job update → immediate GCal update
  - Job delete → immediate GCal delete
  - BrightBase DB is the single source of truth

Also exposes status tracking so the frontend can display last-run times and results.
"""

import logging
from datetime import datetime, timezone
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger

from database.db import SessionLocal
from database.models import Property, RecurringSchedule, Job, Client

log = logging.getLogger(__name__)

# ── Run history (in-memory, survives until restart) ──────────────────────────
_run_history: dict[str, dict[str, Any]] = {}

_scheduler: BackgroundScheduler | None = None


def get_status() -> dict:
    """Return scheduler status + last-run info for each task."""
    return {
        "running": _scheduler is not None and _scheduler.running,
        "tasks": {
            "ical_sync": _run_history.get("ical_sync", {"last_run": None, "status": "never_run"}),
            "recurring_generation": _run_history.get("recurring_generation", {"last_run": None, "status": "never_run"}),
            "daily_reminders": _run_history.get("daily_reminders", {"last_run": None, "status": "never_run"}),
        },
    }


def _record(task_name: str, result: dict, error: str | None = None):
    _run_history[task_name] = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "status": "error" if error else "ok",
        "error": error,
        "result": result,
    }


# ── Task: iCal Sync ─────────────────────────────────────────────────────────

def task_ical_sync():
    """Sync all active properties that have an iCal URL."""
    from integrations.ical_sync import sync_property

    db = SessionLocal()
    try:
        props = db.query(Property).filter(
            Property.active == True,
            Property.ical_url.isnot(None),
            Property.ical_url != "",
        ).all()

        total_jobs = 0
        total_events = 0
        errors = []

        for prop in props:
            try:
                result = sync_property(db, prop)
                if "error" in result:
                    errors.append({"property": prop.name, "error": result["error"]})
                else:
                    total_jobs += result.get("jobs_created", 0)
                    total_events += result.get("events_created", 0)
            except Exception as e:
                errors.append({"property": prop.name, "error": str(e)})

        summary = {
            "properties_synced": len(props),
            "jobs_created": total_jobs,
            "events_created": total_events,
            "errors": errors,
        }
        _record("ical_sync", summary, errors[0]["error"] if errors and not total_jobs else None)
        log.info(f"[scheduler] iCal sync: {len(props)} properties, {total_jobs} jobs created")
    except Exception as e:
        _record("ical_sync", {}, str(e))
        log.error(f"[scheduler] iCal sync failed: {e}")
    finally:
        db.close()


# ── Task: Recurring Job Generation ───────────────────────────────────────────

def task_recurring_generation():
    """Generate jobs for all active recurring schedules."""
    from modules.recurring.router import generate_jobs

    db = SessionLocal()
    try:
        schedules = db.query(RecurringSchedule).filter(
            RecurringSchedule.active == True
        ).all()

        total_created = 0
        errors = []

        for sched in schedules:
            try:
                count = generate_jobs(db, sched)
                total_created += count
            except Exception as e:
                errors.append({"schedule_id": sched.id, "title": sched.title, "error": str(e)})

        summary = {
            "schedules_processed": len(schedules),
            "jobs_created": total_created,
            "errors": errors,
        }
        _record("recurring_generation", summary)
        log.info(f"[scheduler] Recurring generation: {len(schedules)} schedules, {total_created} jobs created")
    except Exception as e:
        _record("recurring_generation", {}, str(e))
        log.error(f"[scheduler] Recurring generation failed: {e}")
    finally:
        db.close()


# ── Task: Daily SMS Reminders ────────────────────────────────────────────────

def task_daily_reminders():
    """Send SMS reminders for tomorrow's jobs."""
    from datetime import date, timedelta
    from integrations.twilio_client import send_sms

    db = SessionLocal()
    try:
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        jobs = db.query(Job).filter(
            Job.scheduled_date == tomorrow,
            Job.status == "scheduled",
            Job.sms_reminder_sent == False,
        ).all()

        sent = 0
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
                send_sms(to=client.phone, body=msg)
                job.sms_reminder_sent = True
                sent += 1
            except Exception as e:
                errors.append({"job_id": job.id, "error": str(e)})

        db.commit()
        summary = {"date": tomorrow, "reminders_sent": sent, "errors": errors}
        _record("daily_reminders", summary)
        log.info(f"[scheduler] Daily reminders: {sent} sent for {tomorrow}")
    except Exception as e:
        _record("daily_reminders", {}, str(e))
        log.error(f"[scheduler] Daily reminders failed: {e}")
    finally:
        db.close()


# ── Scheduler Lifecycle ──────────────────────────────────────────────────────

def start_scheduler():
    """Start the background scheduler with all automated tasks."""
    global _scheduler

    if _scheduler and _scheduler.running:
        log.warning("[scheduler] Already running, skipping start")
        return

    _scheduler = BackgroundScheduler(timezone="America/New_York")

    # iCal sync — every 15 minutes
    _scheduler.add_job(
        task_ical_sync,
        trigger=IntervalTrigger(minutes=15),
        id="ical_sync",
        name="iCal Sync (Airbnb/VRBO)",
        replace_existing=True,
    )

    # Recurring job generation — daily at 2:00 AM ET
    _scheduler.add_job(
        task_recurring_generation,
        trigger=CronTrigger(hour=2, minute=0),
        id="recurring_generation",
        name="Recurring Job Generation",
        replace_existing=True,
    )

    # Daily SMS reminders — daily at 9:00 AM ET
    _scheduler.add_job(
        task_daily_reminders,
        trigger=CronTrigger(hour=9, minute=0),
        id="daily_reminders",
        name="Daily SMS Reminders",
        replace_existing=True,
    )

    _scheduler.start()
    log.info("[scheduler] Background scheduler started with 3 automated tasks")


def stop_scheduler():
    """Gracefully shut down the scheduler."""
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("[scheduler] Background scheduler stopped")
    _scheduler = None


def run_task_now(task_name: str) -> dict:
    """Manually trigger a task immediately. Returns the result."""
    tasks = {
        "ical_sync": task_ical_sync,
        "recurring_generation": task_recurring_generation,
        "daily_reminders": task_daily_reminders,
    }
    if task_name not in tasks:
        return {"error": f"Unknown task: {task_name}. Available: {list(tasks.keys())}"}

    try:
        tasks[task_name]()
        return _run_history.get(task_name, {"status": "completed"})
    except Exception as e:
        return {"error": str(e)}
