"""Background scheduler for iCal auto-sync."""

import logging
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from config import env_flag, env_int
from database.db import SessionLocal
from database.models import Property
from integrations.ical_sync import sync_property

log = logging.getLogger(__name__)

_scheduler = None


def sync_all_ical_feeds_tick() -> dict:
    """Main background job to sync all iCal feeds."""
    db = SessionLocal()
    try:
        props = db.query(Property).filter(
            Property.active == True,
            Property.ical_url != None,
        ).all()

        properties_checked = len(props)
        properties_synced = 0
        properties_failed = 0
        total_jobs_created = 0
        failures = []

        for prop in props:
            try:
                result = sync_property(db, prop)
                if "error" not in result:
                    properties_synced += 1
                    total_jobs_created += result.get("jobs_created", 0)
                else:
                    properties_failed += 1
                    failures.append({
                        "property_id": prop.id,
                        "property_name": prop.name,
                        "error": result["error"],
                    })
            except Exception as e:
                properties_failed += 1
                failures.append({
                    "property_id": prop.id,
                    "property_name": prop.name,
                    "error": str(e),
                })

        return {
            "properties_checked": properties_checked,
            "properties_synced": properties_synced,
            "properties_failed": properties_failed,
            "total_jobs_created": total_jobs_created,
            "failures": failures,
        }
    finally:
        db.close()


def start_scheduler():
    """Start the background scheduler."""
    global _scheduler

    if not env_flag("ICAL_AUTO_SYNC_ENABLED", True):
        log.info("iCal auto-sync disabled via ICAL_AUTO_SYNC_ENABLED=0")
        return None

    interval_minutes = env_int("ICAL_AUTO_SYNC_INTERVAL_MINUTES", 15)

    _scheduler = BackgroundScheduler()
    _scheduler.add_job(
        sync_all_ical_feeds_tick,
        IntervalTrigger(minutes=interval_minutes),
        id="ical_sync",
        name="iCal auto-sync",
        replace_existing=True,
    )
    _scheduler.start()
    log.info(f"iCal auto-sync scheduler started (interval: {interval_minutes} min)")
    return _scheduler


def stop_scheduler():
    """Safely shut down the scheduler."""
    global _scheduler
    if _scheduler:
        try:
            _scheduler.shutdown(wait=True)
            log.info("iCal auto-sync scheduler stopped")
        except Exception as e:
            log.warning(f"Error stopping scheduler: {e}")
        finally:
            _scheduler = None
