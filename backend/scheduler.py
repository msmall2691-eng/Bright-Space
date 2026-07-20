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
from utils.dates import business_today

log = logging.getLogger(__name__)

_scheduler = None


def _db_flag(db, key: str, env_default: bool) -> bool:
    """Read a boolean flag from app_settings, falling back to env_default."""
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is None or row.value is None:
        return env_default
    return str(row.value).strip().lower() in {"1", "true", "yes", "on"}


# Explicit "the deployment turned this off" check. env_flag() is a
# truthy/falsy predicate — anything not in its whitelist reads as False,
# which is wrong for a HARD-OFF gate (a stray "foo" would silently disable
# the reminder tick while the status endpoint still reported ON). This
# helper shares one authoritative interpretation with
# modules.settings.router.messaging_status so the tick's behavior and the
# UI's "env_disabled" surface never diverge (Codex review on #520).
def env_hard_off(name: str) -> bool:
    import os as _os
    return _os.getenv(name, "").strip().lower() in {"0", "false", "no", "off"}


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
    from integrations.gcal_sync import sync_gcal_cancellations, calendar_source_of_truth
    db = SessionLocal()
    try:
        if not _db_flag(db, "gcal_auto_sync_enabled", env_flag("GCAL_AUTO_SYNC_ENABLED", True)):
            log.debug("GCal auto-sync disabled via app_settings; skipping tick")
            return {"skipped": True, "reason": "disabled"}
        # One-way (BrightBase is master) is the default: we push the schedule
        # OUT to Google (sync_reconcile_tick / inline create) and read NOTHING
        # back — no importing events created in Google, no cancelling a BB job
        # because its Google event was deleted. Only the explicit two-way mode
        # (calendar_source_of_truth == "google") pulls Google edits in.
        if calendar_source_of_truth(db) != "google":
            log.debug("GCal one-way (BrightBase master); skipping read-back tick")
            return {"skipped": True, "reason": "one_way"}
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
                # Roll back the shared session before moving on. Without this, a
                # failed flush leaves the transaction aborted (Postgres:
                # InFailedSqlTransaction) and every subsequent schedule's
                # generate_jobs would fail on its first query — one bad schedule
                # would starve visit generation for all the others in this tick.
                db.rollback()
                log.warning(f"Recurring generate failed for schedule {s.id}: {e}")
                per_schedule.append({"schedule_id": s.id, "error": str(e)})
        log.info(f"Recurring auto-generate: {len(schedules)} schedules, {total_jobs} jobs created")
        return {"schedules_processed": len(schedules), "jobs_created": total_jobs, "per_schedule": per_schedule}
    except Exception as e:
        log.error(f"Recurring auto-generate failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()

def invoice_dunning_tick() -> dict:
    """Background job: chase overdue invoices at +1/+7/+14 days past due (T-03).

    Gating (mirrors job_sms_reminders_tick):
      1. `JOB_DUNNING_ENABLED=0` env → HARD off. Emergency deployment kill.
      2. `dunning_enabled` app_setting — Meg's in-app toggle. OFF by default
         so a fresh deploy never emails customers without an explicit opt-in.
      3. Otherwise: delegate to services.dunning_service.send_due_dunning
         which advances Invoice.dunning_stage for idempotency.
    """
    from services.dunning_service import send_due_dunning
    db = SessionLocal()
    try:
        if env_hard_off("JOB_DUNNING_ENABLED"):
            log.debug("Invoice dunning hard-disabled via env; skipping tick")
            return {"skipped": True, "reason": "env_disabled"}
        if not _db_flag(db, "dunning_enabled", False):
            log.debug("Invoice dunning disabled via app_setting; skipping tick")
            return {"skipped": True, "reason": "app_disabled"}
        result = send_due_dunning(db)
        log.info(f"Invoice dunning: {result}")
        return result
    except Exception as e:
        log.error(f"Invoice dunning failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def job_sms_reminders_tick() -> dict:
    """Background job: text clients a reminder ahead of their cleaning.

    Gating (in order):
      1. `JOB_SMS_REMINDERS_ENABLED=0` env → HARD off. Emergency deployment
         kill (dev, compliance). Anything else — unset, `1`, `true` — falls
         through to the DB flag.
      2. `job_sms_reminders_enabled` app_setting — Meg's in-app toggle. OFF
         by default so a fresh deploy never texts customers without an
         explicit opt-in from Settings.
      3. Otherwise: send due reminders. The reminder service uses
         Job.sms_reminder_sent for idempotency.

    Before T-04 the OUTER scheduler.start_scheduler() also gated tick
    registration on the env flag, which meant Meg's Settings toggle did
    nothing without a redeploy — the tick simply wasn't running. Now the
    tick is registered unconditionally; the gates above decide whether it
    actually sends.
    """
    from services.reminder_service import send_due_reminders
    db = SessionLocal()
    try:
        # Env is an emergency-off, not a truthy/falsy default. `env_hard_off`
        # only triggers on explicit `0`/`false`/`no`/`off` — shared with
        # messaging_status so the tick and UI can't disagree on what
        # "env_disabled" means.
        if env_hard_off("JOB_SMS_REMINDERS_ENABLED"):
            log.debug("Job SMS reminders hard-disabled via env; skipping tick")
            return {"skipped": True, "reason": "env_disabled"}
        if not _db_flag(db, "job_sms_reminders_enabled", False):
            log.debug("Job SMS reminders disabled via app_setting; skipping tick")
            return {"skipped": True, "reason": "app_disabled"}
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
        #    max_results=120: the fetch walks newest-first within the SINCE
        #    cursor window, so on a busy day a low cap (was 30) silently drops
        #    the oldest of the day's mail before it's ever threaded.
        result = run_inbox_sync(db, max_results=120, skip_automated=True, auto_enrich=True)
        if result.get("error"):
            log.info(f"Gmail auto-sync (shared inbox) skipped: {result.get('error')}")
        summary = dict(result.get("summary") or {"total": 0, "threaded": 0})

        # Persist shared-inbox sync health so Settings → Email can show whether
        # auto-sync is actually working. An expired App Password otherwise fails
        # SILENTLY (only a Railway log line), which is the whole reason "is email
        # even syncing?" is unanswerable today. Best-effort; never breaks the tick.
        try:
            from datetime import datetime, timezone
            from modules.settings.router import set_setting
            status = result.get("error") or "ok"
            set_setting(db, "gmail_inbox_last_sync_at", datetime.now(timezone.utc).isoformat())
            set_setting(db, "gmail_inbox_last_sync_status", status)
            set_setting(db, "gmail_inbox_last_sync_error", result.get("message") or "")
            set_setting(db, "gmail_inbox_last_sync_threaded", str(summary.get("threaded", 0)))
            db.commit()
        except Exception as e:
            log.warning(f"Could not persist gmail sync status: {e}")

        # 2) Per-user connected Google accounts (Gmail API, phase C). Each
        #    account is isolated: an expired grant marks itself for reconnect
        #    and the rest keep syncing.
        try:
            from integrations.google_accounts import gmail_accounts
            for acct in gmail_accounts(db):
                acct_summary = run_account_inbox_sync(db, acct, max_results=60).get("summary") or {}
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


def schedule_audit_tick() -> dict:
    """Frequent, read-only audit of the schedule for duplicate jobs + orphaned
    Connecteam shifts. Logs a warning when anything's found so problems surface
    on their own instead of piling up. Never mutates the schedule — the operator
    (or the reconcile drift-repair) fixes what it flags."""
    db = SessionLocal()
    try:
        from modules.scheduling.router import find_schedule_issues
        issues = find_schedule_issues(db)
        c = issues.get("counts", {})
        if c.get("duplicate_groups") or c.get("orphaned_shifts"):
            log.warning(
                "[schedule-audit] %s duplicate job group(s), %s orphaned shift(s) — "
                "review at GET /api/jobs/audit. dupes=%s orphans=%s",
                c.get("duplicate_groups", 0), c.get("orphaned_shifts", 0),
                issues["duplicate_jobs"][:10], issues["orphaned_shifts"][:10],
            )
        return c
    except Exception as e:
        log.error(f"[schedule-audit] failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def connecteam_outbox_drain_tick() -> dict:
    """Drain the Connecteam sync outbox frequently so enqueued shift syncs reach
    Connecteam near-real-time instead of waiting for the 30-minute reconcile.

    Cheap no-op when the outbox is off (nothing is ever enqueued) or empty —
    one indexed `status='pending'` lookup. Best-effort; per-row failures are
    retried with backoff inside drain_outbox."""
    db = SessionLocal()
    try:
        from integrations.connecteam import is_configured
        if not is_configured():
            return {"skipped": "not_configured"}
        from integrations.connecteam_outbox import drain_outbox
        result = drain_outbox(db)
        if result.get("processed") or result.get("failed"):
            log.info(f"Connecteam outbox: {result['processed']} done, {result['failed']} failed")
        return result
    except Exception as e:
        log.error(f"Connecteam outbox drain failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def sync_reconcile_tick() -> dict:
    """Self-healing push reconcile for Google Calendar + Connecteam.

    Job creation pushes to Google / dispatches to Connecteam inline; when that
    inline push fails (Google briefly down, integration connected *after* the
    job was created, transient Connecteam error) the job silently stays
    unsynced until someone notices the yellow "Needs attention" banner and runs
    Tools -> Push to Google. This tick closes that gap automatically, using the
    exact same code paths as the manual actions.

    Gated by sync_reconcile_enabled (app_settings) / SYNC_RECONCILE_ENABLED
    (env, default ON). Safe to run repeatedly: both paths skip jobs that are
    already synced, cancelled/completed, or in the past.
    """
    from datetime import timedelta
    from utils.dates import coerce_date

    db = SessionLocal()
    try:
        if not _db_flag(db, "sync_reconcile_enabled",
                        env_flag("SYNC_RECONCILE_ENABLED", True)):
            return {"skipped": True, "reason": "disabled"}
        result = {}

        # 1) Google Calendar: reuse the manual "Push to Google" logic verbatim.
        try:
            from integrations.google_calendar import is_configured as _gcal_ok
            if _gcal_ok():
                from modules.scheduling.router import push_to_gcal
                # One-way self-heal (BrightBase is master): re-push events a user
                # deleted in Google before the normal push, so a cleaning that
                # vanished from Google reappears instead of staying missing.
                try:
                    from integrations.gcal_sync import reassert_deleted_gcal_events
                    healed = reassert_deleted_gcal_events(db)
                    if healed.get("restored"):
                        log.info(f"Sync reconcile: restored {healed['restored']} event(s) deleted in Google")
                except Exception as e:
                    log.warning(f"Sync reconcile: Google re-assert failed (non-fatal): {e}")
                pushed = push_to_gcal(db)
                if pushed.get("pushed"):
                    log.info(f"Sync reconcile: pushed {pushed['pushed']} job(s) to Google Calendar")
                if pushed.get("errors"):
                    log.warning(
                        f"Sync reconcile: {len(pushed['errors'])} GCal push error(s), "
                        f"first: {pushed['errors'][:1]}"
                    )
                result["gcal"] = {"pushed": pushed.get("pushed", 0),
                                  "errors": len(pushed.get("errors") or [])}
            else:
                result["gcal"] = {"skipped": "not_configured"}
        except Exception as e:
            log.warning(f"Sync reconcile: GCal push failed: {e}")
            result["gcal"] = {"error": str(e)}

        # 2) Connecteam: read-back reconcile, dispatch, then drift repair.
        #    auto_dispatch_job() no-ops safely on anything that shouldn't sync.
        try:
            from integrations.connecteam import is_configured as _ct_ok
            if _ct_ok():
                from integrations.connecteam_auto import (
                    auto_dispatch_job, reconcile_connecteam_drift, read_back_reconcile,
                )
                from database.models import Job
                from modules.settings.router import connecteam_auto_dispatch_enabled
                _auto_ok = connecteam_auto_dispatch_enabled(db)
                # One window (-7 .. +30 days) feeds read-back and drift; the
                # dispatch loop takes the upcoming active subset. This tick runs
                # across ALL orgs (no user context), so the read-back's
                # unrecognized list is a true account-wide orphan report.
                drift_start = (business_today() - timedelta(days=7)).isoformat()
                end = (business_today() + timedelta(days=30)).isoformat()
                today = business_today()
                window_jobs = db.query(Job).filter(
                    Job.scheduled_date >= drift_start,
                    Job.scheduled_date <= end,
                ).all()
                errors = 0

                # 2-pre) DRAIN the transactional outbox first so queued sync
                # intents are applied before we read back. No-op when the outbox
                # is off or empty.
                try:
                    from integrations.connecteam_outbox import drain_outbox
                    drained = drain_outbox(db)
                    if drained.get("processed") or drained.get("failed"):
                        log.info(f"Sync reconcile: outbox drained {drained['processed']} done, {drained['failed']} failed")
                    errors += len(drained.get("errors") or [])
                except Exception as e:
                    log.warning(f"Sync reconcile: Connecteam outbox drain failed: {e}")

                # 2a) READ-BACK FIRST — reconcile against Connecteam's real
                # shifts so a shift deleted in the Connecteam app is repaired,
                # before we create anything (which would otherwise risk a dup).
                try:
                    from integrations.connecteam import get_scheduled_shifts_sync
                    actual_shifts = get_scheduled_shifts_sync(drift_start, end)
                    rb = read_back_reconcile(db, window_jobs, actual_shifts,
                                             auto_dispatch_on=_auto_ok)
                    errors += len(rb["errors"])
                    if rb["repaired"]:
                        log.info(f"Sync reconcile: recreated {rb['repaired']} vanished Connecteam shift(s)")
                    if rb["unrecognized_count"]:
                        log.info(f"Sync reconcile: {rb['unrecognized_count']} unrecognized Connecteam shift(s) (report-only)")
                except Exception as e:
                    log.warning(f"Sync reconcile: Connecteam read-back failed: {e}")

                # 2b) Dispatch upcoming assigned jobs with no shifts. Manual
                # mode: never auto-push from the background tick.
                dispatched = 0
                for job in window_jobs:
                    jd = coerce_date(job.scheduled_date)
                    if (job.status not in ("scheduled", "in_progress")
                            or jd is None or jd < today
                            or job.connecteam_shift_ids or not job.cleaner_ids or not _auto_ok):
                        continue
                    st = auto_dispatch_job(db, job, commit=False)
                    if st.get("dispatched"):
                        dispatched += 1
                    if st.get("errors"):
                        errors += len(st["errors"])
                db.commit()
                if dispatched:
                    log.info(f"Sync reconcile: dispatched {dispatched} job(s) to Connecteam")

                # 2c) Drift repair — jobs cancelled/completed but still carrying
                # shift ids, or whose schedule moved since the shift was pushed.
                drift = reconcile_connecteam_drift(db, window_jobs)
                if drift["resynced"]:
                    log.info(f"Sync reconcile: retimed {drift['resynced']} drifted Connecteam shift(s)")
                if drift["removed"]:
                    log.info(f"Sync reconcile: removed {drift['removed']} stale Connecteam shift(s)")
                errors += len(drift["errors"])

                result["connecteam"] = {
                    "dispatched": dispatched, "errors": errors,
                    "resynced": drift["resynced"], "removed": drift["removed"],
                }
            else:
                result["connecteam"] = {"skipped": "not_configured"}
        except Exception as e:
            log.warning(f"Sync reconcile: Connecteam dispatch failed: {e}")
            result["connecteam"] = {"error": str(e)}

        return result
    except Exception as e:
        log.error(f"Sync reconcile failed: {e}")
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

        today = business_today().isoformat()

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
        today = business_today()
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
    real-time notifications don't silently lapse. Enabled by the Settings toggle
    (`gcal_live_sync` app_setting) OR the GCAL_WATCH_ENABLED env flag — so an
    operator can turn real-time sync on from the UI without a redeploy. Needs a
    public https base URL. No-ops when disabled."""
    db = SessionLocal()
    try:
        # Recommended default is ON — real-time sync works out of the box.
        if not _db_flag(db, "gcal_live_sync", env_flag("GCAL_WATCH_ENABLED", True)):
            return {"skipped": True, "reason": "disabled"}
        from integrations.gcal_watch import ensure_watches
        from config import app_base_url
        return ensure_watches(db, app_base_url())
    except Exception as e:
        log.error(f"[gcal-watch] renew failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


# Retained across the process lifetime so the OS keeps the exclusive lock
# even after start_scheduler() returns — closing the file drops the lock.
_scheduler_lock_fh = None


def _claim_scheduler_singleton_lock() -> bool:
    """Return True if THIS process should own the background scheduler.

    Multi-worker uvicorn (--workers N) fires FastAPI's `startup` event in
    every worker. Without a lock, each worker would start its own
    BackgroundScheduler, and the same tick (SMS reminders, invoice dunning,
    Gmail/GCal sync, Connecteam reconcile) would fire concurrently in every
    process, racing before Job.sms_reminder_sent / Invoice.dunning_stage
    got committed — producing duplicate customer texts, duplicate dunning
    emails, duplicate external pushes. (Codex P1 on #525.)

    Uses an exclusive OS file lock on a well-known path so only the FIRST
    worker to try succeeds; subsequent workers see BlockingIOError and
    noop. On Railway's container filesystem all worker processes share
    /tmp, so this works without a Redis/DB dependency.

    Override paths:
      SCHEDULER_LOCK_PATH — customize where the lock file lives (dev/CI).
      DISABLE_SCHEDULER=1 — force this process to NOT run the scheduler
        (useful when a separate service owns it).
    """
    import fcntl
    global _scheduler_lock_fh
    if env_flag("DISABLE_SCHEDULER", False):
        log.info("Scheduler explicitly disabled via DISABLE_SCHEDULER=1")
        return False
    import os as _os
    lock_path = _os.getenv("SCHEDULER_LOCK_PATH", "/tmp/brightbase-scheduler.lock")
    try:
        _scheduler_lock_fh = open(lock_path, "w")
        fcntl.flock(_scheduler_lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        _scheduler_lock_fh.write(str(_os.getpid()))
        _scheduler_lock_fh.flush()
        return True
    except BlockingIOError:
        if _scheduler_lock_fh is not None:
            try: _scheduler_lock_fh.close()
            except Exception: pass
            _scheduler_lock_fh = None
        return False
    except OSError as e:
        # Non-Linux platforms without flock, or a filesystem that doesn't
        # support advisory locks. Fall back to letting THIS process run
        # the scheduler — better than not running at all — and log loudly
        # so we can investigate.
        log.warning(f"Scheduler singleton lock unavailable ({e}); "
                    "running scheduler in this process without inter-worker protection.")
        return True


def start_scheduler():
    """Start the background scheduler.

    Only the FIRST worker to claim the singleton lock actually starts it;
    every other worker noops. This keeps multi-worker uvicorn safe: only
    one APScheduler runs across all workers, so ticks can't fire N times
    in parallel and race their idempotency writes.
    """
    global _scheduler

    if not _claim_scheduler_singleton_lock():
        log.info("Scheduler already owned by another worker; skipping start in this process.")
        return None

    _scheduler = BackgroundScheduler()

    # Sync reconcile: self-healing Google Calendar / Connecteam push for jobs
    # whose inline push failed or that predate the integration being connected.
    if env_flag("SYNC_RECONCILE_ENABLED", True):
        reconcile_minutes = env_int("SYNC_RECONCILE_INTERVAL_MINUTES", 30)
        _scheduler.add_job(
            sync_reconcile_tick,
            IntervalTrigger(minutes=reconcile_minutes),
            id="sync_reconcile",
            name="Google/Connecteam sync reconcile",
            replace_existing=True,
        )
        log.info(f"Sync reconcile enabled (interval: {reconcile_minutes} min)")
    else:
        log.info("Sync reconcile disabled via SYNC_RECONCILE_ENABLED=0")

    # Connecteam outbox drain — frequent, cheap, so enqueued shift syncs reach
    # Connecteam near-real-time (no-op when the outbox setting is off or the
    # queue is empty). Independent of SYNC_RECONCILE_ENABLED so the durable path
    # drains even if the heavier reconcile is turned down.
    if env_flag("CONNECTEAM_OUTBOX_DRAIN_ENABLED", True):
        drain_minutes = env_int("CONNECTEAM_OUTBOX_DRAIN_INTERVAL_MINUTES", 2)
        _scheduler.add_job(
            connecteam_outbox_drain_tick,
            IntervalTrigger(minutes=drain_minutes),
            id="connecteam_outbox_drain",
            name="Connecteam outbox drain",
            replace_existing=True,
        )
        log.info(f"Connecteam outbox drain enabled (interval: {drain_minutes} min)")

    # Frequent read-only schedule audit — flags duplicate jobs + orphaned
    # Connecteam shifts so they surface early. Cheap; runs a few times a day.
    _scheduler.add_job(
        schedule_audit_tick,
        IntervalTrigger(hours=env_int("SCHEDULE_AUDIT_INTERVAL_HOURS", 6)),
        id="schedule_audit",
        name="Schedule duplicate/orphan audit",
        replace_existing=True,
    )

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

    # Job SMS reminders — tick registered unconditionally (T-04). Whether it
    # actually sends is decided inside job_sms_reminders_tick by the DB flag
    # (Settings → Automation → "Automatic customer SMS reminders"); the tick
    # short-circuits when disabled, so registering has no cost. Previously
    # this gated on JOB_SMS_REMINDERS_ENABLED, which meant flipping the
    # Settings toggle in prod did nothing without a redeploy.
    reminder_interval_minutes = env_int("JOB_SMS_REMINDER_INTERVAL_MINUTES", 60)
    _scheduler.add_job(
        job_sms_reminders_tick,
        IntervalTrigger(minutes=reminder_interval_minutes),
        id="job_sms_reminders",
        name="Job SMS reminders",
        replace_existing=True,
    )
    log.info(
        f"Job SMS reminders tick registered (interval: {reminder_interval_minutes} min); "
        "activation gated on the in-app Settings toggle."
    )

    # Invoice dunning (T-03) — same shape as the SMS-reminders tick. Once a
    # day is enough; each stage guards against re-fire within the cadence
    # window via Invoice.dunning_stage.
    dunning_interval_hours = env_int("JOB_DUNNING_INTERVAL_HOURS", 24)
    _scheduler.add_job(
        invoice_dunning_tick,
        IntervalTrigger(hours=dunning_interval_hours),
        id="invoice_dunning",
        name="Invoice dunning",
        replace_existing=True,
    )
    log.info(
        f"Invoice dunning tick registered (interval: {dunning_interval_hours}h); "
        "activation gated on the in-app Settings toggle."
    )

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
    # ~weekly expiry so real-time sync doesn't lapse. Registered UNCONDITIONALLY
    # (the tick self-gates on the `gcal_live_sync` Settings toggle / env flag and
    # no-ops when off) so real-time sync can be switched on from the UI at
    # runtime without a redeploy.
    _scheduler.add_job(
        gcal_watch_renew_tick,
        IntervalTrigger(hours=env_int("GCAL_WATCH_RENEW_INTERVAL_HOURS", 12)),
        id="gcal_watch_renew",
        name="Google Calendar watch renewal",
        replace_existing=True,
    )
    # Register push channels ONCE at startup (best-effort) so real-time sync is
    # live immediately after deploy, instead of waiting up to the renewal
    # interval for the first tick. Gated by the same flag (default ON) and
    # no-ops cleanly when Google isn't connected or there's no public URL.
    try:
        _dbs = SessionLocal()
        try:
            if _db_flag(_dbs, "gcal_live_sync", env_flag("GCAL_WATCH_ENABLED", True)):
                from integrations.google_calendar import is_configured as _gcal_ok
                if _gcal_ok():
                    from integrations.gcal_watch import ensure_watches
                    from config import app_base_url
                    res = ensure_watches(_dbs, app_base_url())
                    log.info(f"Google Calendar real-time sync: {res}")
        finally:
            _dbs.close()
    except Exception as e:
        log.warning(f"[gcal-watch] startup registration skipped: {e}")

    _scheduler.start()
    return _scheduler


def stop_scheduler():
    """Safely shut down the scheduler and release the singleton lock so a
    subsequent worker (e.g. an in-place uvicorn restart) can claim it."""
    global _scheduler, _scheduler_lock_fh
    if _scheduler:
        try:
            _scheduler.shutdown(wait=True)
            log.info("iCal auto-sync scheduler stopped")
        except Exception as e:
            log.warning(f"Error stopping scheduler: {e}")
        finally:
            _scheduler = None
    if _scheduler_lock_fh is not None:
        try: _scheduler_lock_fh.close()
        except Exception: pass
        _scheduler_lock_fh = None
