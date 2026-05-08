"""Background scheduler for iCal and Google Calendar auto-sync."""

import logging
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from config import env_flag, env_int
from database.db import SessionLocal
from database.models import AppSetting, Property
from integrations.ical_sync import sync_property
from integrations.gcal_sync import sync_calendar

log = logging.getLogger(__name__)

_scheduler = None


def _db_flag(db, key: str, env_default: bool) -> bool:
    """Read a boolean flag from app_settings, falling back to env_default."""
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is None or row.value is None:
        return env_default
    return str(row.value).strip().lower() in {"1", "true", "yes", "on"}


def sync_gcal_tick() -> dict:
    """Background job to sync Google Calendar events to BrightBase, in
    both directions:
    1. sync_calendar() — pulls events INTO BrightBase (creates Jobs from
       new GCal events, marks Jobs cancelled if the event came back
       cancelled in events.list).
    2. sync_gcal_cancellations() — reverse linkage check that catches
       events fully DELETED from GCal (those disappear from events.list
       so step 1 misses them). Soft-cancels the Job + Visits, writes a
       RecurrenceException if the job was from a recurring schedule.
    """
    from integrations.gcal_sync import sync_gcal_cancellations
    db = SessionLocal()
    try:
        if not _db_flag(db, "gcal_auto_sync_enabled", env_flag("GCAL_AUTO_SYNC_ENABLED", True)):
            log.debug("GCal auto-sync disabled via app_settings; skipping tick")
            return {"skipped": True, "reason": "disabled"}
        result = sync_calendar(db)
        log.info(f"GCal sync completed: {result}")
        try:
            cancellations = sync_gcal_cancellations(db)
            result["cancellations"] = cancellations
        except Exception as e:
            log.warning(f"GCal cancellation backflow failed (non-fatal): {e}")
            result["cancellations"] = {"error": str(e)}
        return result
    except Exception as e:
        log.error(f"GCal sync failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def sync_all_ical_feeds_tick() -> dict:
    """Main background job to sync all iCal feeds."""
    db = SessionLocal()
    try:
        if not _db_flag(db, "ical_auto_sync_enabled", env_flag("ICAL_AUTO_SYNC_ENABLED", True)):
            log.debug("iCal auto-sync disabled via app_settings; skipping tick")
            return {"skipped": True, "reason": "disabled"}
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

    _scheduler = BackgroundScheduler()

    # iCal auto-sync
    if env_flag("ICAL_AUTO_SYNC_ENABLED", True):
        interval_minutes = env_int("ICAL_AUTO_SYNC_INTERVAL_MINUTES", 15)
        _scheduler.add_job(
            sync_all_ical_feeds_tick,
            IntervalTrigger(minutes=interval_minutes),
            id="ical_sync",
            name="iCal auto-sync",
            replace_existing=True,
        )
        log.info(f"iCal auto-sync enabled (interval: {interval_minutes} min)")
    else:
        log.info("iCal auto-sync disabled via ICAL_AUTO_SYNC_ENABLED=0")

    # Google Calendar auto-sync
    if env_flag("GCAL_AUTO_SYNC_ENABLED", True):
        gcal_interval_minutes = env_int("GCAL_AUTO_SYNC_INTERVAL_MINUTES", 10)
        _scheduler.add_job(
            sync_gcal_tick,
            IntervalTrigger(minutes=gcal_interval_minutes),
            id="gcal_sync",
            name="Google Calendar auto-sync",
            replace_existing=True,
        )
        log.info(f"Google Calendar auto-sync enabled (interval: {gcal_interval_minutes} min)")
    else:
        log.info("Google Calendar auto-sync disabled via GCAL_AUTO_SYNC_ENABLED=0")

    _scheduler.start()
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
