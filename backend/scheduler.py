"""Background scheduler for iCal and Google Calendar auto-sync."""

import logging
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import or_, and_
from config import env_flag, env_int
from database.db import SessionLocal
from database.models import AppSetting, Property, PropertyIcal, RecurringSchedule
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
        # Sync any active property with at least one active PropertyIcal feed.
        # Dedupe on Property.id only, then load the rows. A `.distinct()` over
        # full Property rows fails on Postgres ("could not identify an equality
        # operator for type json") because Property has JSON columns.
        prop_ids = [
            row[0] for row in (
                db.query(Property.id)
                .join(PropertyIcal, PropertyIcal.property_id == Property.id)
                .filter(Property.active == True, PropertyIcal.active == True)
                .distinct()
                .all()
            )
        ]
        props = db.query(Property).filter(Property.id.in_(prop_ids)).all() if prop_ids else []

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




def recurring_jobs_tick() -> dict:
    """Background job to materialize jobs from active RecurringSchedules.

    Calls the same generate_jobs function used by /api/recurring/generate-all,
    so recurring residential/commercial cleanings get jobs auto-created on the
    schedule going forward. Idempotent — generate_jobs already skips dates
    that already have a Job (cancelled or otherwise).
    """
    from modules.recurring.router import generate_jobs
    db = SessionLocal()
    try:
        if not _db_flag(db, "recurring_auto_generate_enabled", env_flag("RECURRING_AUTO_GENERATE_ENABLED", True)):
            log.debug("Recurring auto-generate disabled via app_settings; skipping tick")
            return {"skipped": True, "reason": "disabled"}
        schedules = db.query(RecurringSchedule).filter(RecurringSchedule.active == True).all()
        total_jobs = 0
        per_schedule = []
        for s in schedules:
            try:
                created = generate_jobs(db, s)
                total_jobs += created
                per_schedule.append({"schedule_id": s.id, "jobs_created": created})
            except Exception as e:
                log.warning(f"Recurring generate failed for schedule {s.id}: {e}")
                per_schedule.append({"schedule_id": s.id, "error": str(e)})
        log.info(f"Recurring auto-generate: {len(schedules)} schedules, {total_jobs} jobs created")
        return {"schedules_processed": len(schedules), "jobs_created": total_jobs, "per_schedule": per_schedule}
    except Exception as e:
        log.error(f"Recurring auto-generate failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()

def job_sms_reminders_tick() -> dict:
    """Background job: text clients a reminder ahead of their cleaning.

    OFF by default (it texts real customers). Gate: job_sms_reminders_enabled
    app_setting / JOB_SMS_REMINDERS_ENABLED env. Delegates to the reminder
    service, which uses Job.sms_reminder_sent for idempotency.
    """
    from services.reminder_service import send_due_reminders
    db = SessionLocal()
    try:
        if not _db_flag(db, "job_sms_reminders_enabled", env_flag("JOB_SMS_REMINDERS_ENABLED", False)):
            log.debug("Job SMS reminders disabled; skipping tick")
            return {"skipped": True, "reason": "disabled"}
        result = send_due_reminders(db)
        log.info(f"Job SMS reminders: {result}")
        return result
    except Exception as e:
        log.error(f"Job SMS reminders failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def sync_gmail_inbox_tick() -> dict:
    """Background job to pull the Gmail inbox and thread new emails into the
    unified comms inbox (Conversations), so emails appear alongside SMS without
    anyone having to open the Email tab. Mirrors the on-demand GET /gmail/inbox.

    Gated behind gmail_auto_sync_enabled (app_settings) / GMAIL_AUTO_SYNC_ENABLED.
    A missing/invalid Gmail credential is an expected non-error here — the
    endpoint returns an {"error": ...} envelope rather than raising — so we
    surface it as a skip, not a failure.
    """
    from modules.gmail.router import run_inbox_sync, run_account_inbox_sync
    db = SessionLocal()
    try:
        if not _db_flag(db, "gmail_auto_sync_enabled", env_flag("GMAIL_AUTO_SYNC_ENABLED", True)):
            log.debug("Gmail auto-sync disabled via app_settings; skipping tick")
            return {"skipped": True, "reason": "disabled"}
        # 1) Legacy shared business inbox (IMAP App Password) — kept as a
        #    permanent fallback by decision (auth-workspaces plan §0.3).
        result = run_inbox_sync(db, max_results=30, skip_automated=True, auto_enrich=True)
        if result.get("error"):
            log.info(f"Gmail auto-sync (shared inbox) skipped: {result.get('error')}")
        summary = dict(result.get("summary") or {"total": 0, "threaded": 0})

        # 2) Per-user connected Google accounts (Gmail API, phase C). Each
        #    account is isolated: an expired grant marks itself for reconnect
        #    and the rest keep syncing.
        try:
            from integrations.google_accounts import gmail_accounts
            for acct in gmail_accounts(db):
                acct_summary = run_account_inbox_sync(db, acct, max_results=30).get("summary") or {}
                summary["total"] = summary.get("total", 0) + acct_summary.get("total", 0)
                summary["threaded"] = summary.get("threaded", 0) + acct_summary.get("threaded", 0)
        except Exception as e:
            log.error(f"Per-account Gmail sync pass failed: {e}")

        log.info(f"Gmail auto-sync: {summary.get('threaded', 0)} new emails threaded "
                 f"({summary.get('total', 0)} fetched)")
        return summary
    except Exception as e:
        log.error(f"Gmail auto-sync failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def str_turnover_autoassign_tick() -> dict:
    """Auto-assign available cleaners to upcoming unassigned STR turnover jobs.
    OFF by default (it changes real assignments). Gate:
    str_turnover_autoassign_enabled (app_settings) / STR_TURNOVER_AUTOASSIGN_ENABLED."""
    db = SessionLocal()
    try:
        if not _db_flag(db, "str_turnover_autoassign_enabled",
                        env_flag("STR_TURNOVER_AUTOASSIGN_ENABLED", False)):
            return {"skipped": True}
        from modules.scheduling.router import auto_assign_unassigned_turnovers
        result = auto_assign_unassigned_turnovers(db)
        if result.get("assigned"):
            log.info(f"Turnover auto-assign: assigned {len(result['assigned'])} job(s)")
        return result
    except Exception as e:
        log.error(f"Turnover auto-assign failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def daily_briefing_tick() -> dict:
    """Pre-generate the AI daily briefing and cache it, so the dashboard loads
    it instantly (and it stays consistent through the day). Gated behind
    ai_daily_briefing_enabled (app_settings) / AI_DAILY_BRIEFING_ENABLED env."""
    db = SessionLocal()
    try:
        if not _db_flag(db, "ai_daily_briefing_enabled", env_flag("AI_DAILY_BRIEFING_ENABLED", True)):
            return {"skipped": True}
        # Imported lazily so the scheduler doesn't hard-depend on the AI module.
        from modules.ai.router import generate_and_cache_briefing
        generate_and_cache_briefing(db)
        log.info("AI daily briefing pre-generated and cached")
        return {"ok": True}
    except Exception as e:
        log.error(f"AI daily briefing pre-generation failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def turnover_coverage_tick() -> dict:
    """Proactive daily safety net: every upcoming guest checkout should have an
    active turnover. Read-only — the iCal tick already syncs feeds; this just
    verifies coverage and logs LOUDLY (ERROR) if any property is missing a
    turnover, so a gap is caught automatically instead of only when someone opens
    "Check all turnovers". Gated by turnover_coverage_check_enabled /
    TURNOVER_COVERAGE_CHECK_ENABLED."""
    from datetime import date
    from database.models import Property, PropertyIcal, ICalEvent, Job
    db = SessionLocal()
    try:
        if not _db_flag(db, "turnover_coverage_check_enabled",
                        env_flag("TURNOVER_COVERAGE_CHECK_ENABLED", True)):
            return {"skipped": True, "reason": "disabled"}

        today = date.today().isoformat()

        def _d(x):
            return x if isinstance(x, str) else (x.isoformat() if x else None)

        prop_ids = [
            r[0] for r in (
                db.query(Property.id)
                .join(PropertyIcal, PropertyIcal.property_id == Property.id)
                .filter(Property.active == True, PropertyIcal.active == True)
                .distinct()
                .all()
            )
        ]

        flagged = []
        total_missing = 0
        for pid in prop_ids:
            prop = db.query(Property).filter(Property.id == pid).first()
            expected = {
                _d(e.checkout_date) for e in db.query(ICalEvent).filter(
                    ICalEvent.property_id == pid).all()
                if getattr(e, "event_type", "reservation") == "reservation"
                and e.checkout_date and _d(e.checkout_date) >= today
            }
            active = {
                _d(j.scheduled_date) for j in db.query(Job).filter(
                    Job.property_id == pid,
                    Job.job_type == "str_turnover",
                    Job.status.notin_(["cancelled"]),
                    Job.scheduled_date.isnot(None),
                ).all()
                if j.scheduled_date and _d(j.scheduled_date) >= today
            }
            missing = sorted(expected - active)
            # A failing feed makes "expected" stale — a brand-new reservation
            # won't be in ICalEvent yet — so coverage can't be trusted. Treat a
            # feed outage as unhealthy too (mirrors turnover_sweep), so an outage
            # can't produce a false all-clear while a turnover is actually missing.
            failed_feeds = [
                (pi.source or "feed") for pi in (prop.property_icals or [])
                if getattr(pi, "active", True) and pi.last_sync_status in ("failed", "retrying")
            ]
            if missing or failed_feeds:
                name = prop.name if prop else str(pid)
                total_missing += len(missing)
                entry = {"property_id": pid, "property": name, "missing": missing}
                if failed_feeds:
                    entry["feed_errors"] = failed_feeds
                flagged.append(entry)
                if missing:
                    log.error(
                        f"[turnover-coverage] {name}: "
                        f"{len(missing)} upcoming checkout(s) with NO turnover: {missing}"
                    )
                if failed_feeds:
                    log.error(
                        f"[turnover-coverage] {name}: feed sync failing ({failed_feeds}) — "
                        f"coverage may be understated until it recovers"
                    )
        if not flagged:
            log.info(f"[turnover-coverage] all upcoming checkouts covered across {len(prop_ids)} STR property(ies)")
        return {"properties_checked": len(prop_ids), "missing_total": total_missing, "flagged": flagged}
    except Exception as e:
        log.error(f"[turnover-coverage] check failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def quote_expiry_tick() -> dict:
    """Flip past-due sent/viewed quotes to 'expired' so they drop out of the
    follow-up list and customers can't accept a stale quote. Gated by
    quote_auto_expire_enabled / QUOTE_AUTO_EXPIRE_ENABLED (default on)."""
    from datetime import date
    from database.models import Quote
    from utils.dates import coerce_date
    db = SessionLocal()
    try:
        if not _db_flag(db, "quote_auto_expire_enabled",
                        env_flag("QUOTE_AUTO_EXPIRE_ENABLED", True)):
            return {"skipped": True, "reason": "disabled"}
        today = date.today()
        expired = 0
        # valid_until may be a str on drifted rows — coerce per row instead of
        # filtering in SQL so the comparison is always date-vs-date.
        for q in db.query(Quote).filter(Quote.status.in_(["sent", "viewed"])).all():
            vu = coerce_date(q.valid_until)
            if vu and vu < today:
                q.status = "expired"
                expired += 1
        if expired:
            db.commit()
        return {"expired": expired}
    except Exception as e:
        log.error(f"[quote-expiry] sweep failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def gcal_watch_renew_tick() -> dict:
    """Renew Google Calendar push channels before they expire (~weekly cap), so
    real-time notifications don't silently lapse. Gated by GCAL_WATCH_ENABLED
    (off by default — needs a public https base URL)."""
    if not env_flag("GCAL_WATCH_ENABLED", False):
        return {"skipped": True, "reason": "disabled"}
    from integrations.gcal_watch import renew_expiring
    from config import app_base_url
    db = SessionLocal()
    try:
        return renew_expiring(db, app_base_url())
    except Exception as e:
        log.error(f"[gcal-watch] renew failed: {e}")
        return {"error": str(e)}
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


    # Gmail inbox auto-sync — thread inbound emails into the unified inbox
    if env_flag("GMAIL_AUTO_SYNC_ENABLED", True):
        gmail_interval_minutes = env_int("GMAIL_AUTO_SYNC_INTERVAL_MINUTES", 10)
        _scheduler.add_job(
            sync_gmail_inbox_tick,
            IntervalTrigger(minutes=gmail_interval_minutes),
            id="gmail_sync",
            name="Gmail inbox auto-sync",
            replace_existing=True,
        )
        log.info(f"Gmail inbox auto-sync enabled (interval: {gmail_interval_minutes} min)")
    else:
        log.info("Gmail inbox auto-sync disabled via GMAIL_AUTO_SYNC_ENABLED=0")

    # Job SMS reminders — OFF by default (texts real customers). Hourly tick so
    # each job gets one reminder ~lead_hours before it starts.
    if env_flag("JOB_SMS_REMINDERS_ENABLED", False):
        reminder_interval_minutes = env_int("JOB_SMS_REMINDER_INTERVAL_MINUTES", 60)
        _scheduler.add_job(
            job_sms_reminders_tick,
            IntervalTrigger(minutes=reminder_interval_minutes),
            id="job_sms_reminders",
            name="Job SMS reminders",
            replace_existing=True,
        )
        log.info(f"Job SMS reminders enabled (interval: {reminder_interval_minutes} min)")
    else:
        log.info("Job SMS reminders disabled (set JOB_SMS_REMINDERS_ENABLED=1 to enable)")

    # Recurring residential/commercial job generation (runs daily)
    if env_flag("RECURRING_AUTO_GENERATE_ENABLED", True):
        recurring_interval_hours = env_int("RECURRING_AUTO_GENERATE_INTERVAL_HOURS", 24)
        _scheduler.add_job(
            recurring_jobs_tick,
            IntervalTrigger(hours=recurring_interval_hours),
            id="recurring_jobs",
            name="Recurring jobs auto-generate",
            replace_existing=True,
        )
        log.info(f"Recurring auto-generate enabled (interval: {recurring_interval_hours} hr)")
    else:
        log.info("Recurring auto-generate disabled via RECURRING_AUTO_GENERATE_ENABLED=0")

    # STR turnover auto-assignment — OFF by default (mutates assignments).
    # When on, periodically assigns available cleaners to unassigned turnovers.
    if env_flag("STR_TURNOVER_AUTOASSIGN_ENABLED", False):
        autoassign_interval_minutes = env_int("STR_TURNOVER_AUTOASSIGN_INTERVAL_MINUTES", 30)
        _scheduler.add_job(
            str_turnover_autoassign_tick,
            IntervalTrigger(minutes=autoassign_interval_minutes),
            id="str_turnover_autoassign",
            name="STR turnover auto-assign",
            replace_existing=True,
        )
        log.info(f"STR turnover auto-assign enabled (interval: {autoassign_interval_minutes} min)")
    else:
        log.info("STR turnover auto-assign disabled (set STR_TURNOVER_AUTOASSIGN_ENABLED=1 to enable)")

    # AI daily briefing — pre-generate once each morning so the dashboard
    # briefing is instant and consistent all day. Hour configurable.
    if env_flag("AI_DAILY_BRIEFING_ENABLED", True):
        briefing_hour = env_int("AI_DAILY_BRIEFING_HOUR", 6)
        _scheduler.add_job(
            daily_briefing_tick,
            CronTrigger(hour=briefing_hour, minute=0),
            id="ai_daily_briefing",
            name="AI daily briefing pre-generate",
            replace_existing=True,
        )
        log.info(f"AI daily briefing pre-generate enabled (daily at {briefing_hour:02d}:00)")
    else:
        log.info("AI daily briefing pre-generate disabled via AI_DAILY_BRIEFING_ENABLED=0")

    # Turnover coverage check — proactive daily safety net that logs loudly if any
    # upcoming guest checkout is missing a turnover.
    if env_flag("TURNOVER_COVERAGE_CHECK_ENABLED", True):
        coverage_hour = env_int("TURNOVER_COVERAGE_CHECK_HOUR", 5)
        _scheduler.add_job(
            turnover_coverage_tick,
            CronTrigger(hour=coverage_hour, minute=30),
            id="turnover_coverage",
            name="Turnover coverage check",
            replace_existing=True,
        )
        log.info(f"Turnover coverage check enabled (daily at {coverage_hour:02d}:30)")
    else:
        log.info("Turnover coverage check disabled via TURNOVER_COVERAGE_CHECK_ENABLED=0")

    # Quote auto-expiry — daily sweep flipping past-due sent/viewed quotes to
    # 'expired' so they leave the follow-up list and can't be accepted stale.
    if env_flag("QUOTE_AUTO_EXPIRE_ENABLED", True):
        expiry_hour = env_int("QUOTE_AUTO_EXPIRE_HOUR", 4)
        _scheduler.add_job(
            quote_expiry_tick,
            CronTrigger(hour=expiry_hour, minute=0),
            id="quote_auto_expire",
            name="Quote auto-expiry sweep",
            replace_existing=True,
        )
        log.info(f"Quote auto-expiry enabled (daily at {expiry_hour:02d}:00)")
    else:
        log.info("Quote auto-expiry disabled via QUOTE_AUTO_EXPIRE_ENABLED=0")

    # Google Calendar push-channel renewal — re-registers watches before their
    # ~weekly expiry so real-time sync doesn't lapse. Off by default.
    if env_flag("GCAL_WATCH_ENABLED", False):
        _scheduler.add_job(
            gcal_watch_renew_tick,
            IntervalTrigger(hours=env_int("GCAL_WATCH_RENEW_INTERVAL_HOURS", 12)),
            id="gcal_watch_renew",
            name="Google Calendar watch renewal",
            replace_existing=True,
        )
        log.info("Google Calendar watch renewal enabled")

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
