"""One consolidated, read-only picture of every schedule BrightBase syncs with.

This is the data behind the **Sync Control Center** (frontend `/sync`). The point
is legibility: the scheduling engine already has a clean model — *BrightBase is the
master and pushes one-way out to Google Calendar and Connecteam; Airbnb/VRBO iCal
feeds pull inbound as turnover jobs; recurring generation is internal* — but that
truth was scattered across a health pill, a toggles panel, per-feed status on
property pages, and ~14 invisible background ticks. Nobody could see the whole
nervous system at once, so it *felt* out of control even when it was fine.

`build_sync_overview()` rolls all of it into a single dict:

  * one row per **channel** (google / connecteam / airbnb / recurring), each with a
    flow **direction** (out / in / internal), who **wins** a conflict (authority),
    whether it's connected + enabled, when it last synced, and its current backlog;
  * the **background jobs** ("the hidden hands") with their real cadences, so the
    operator can finally see what runs on its own;
  * an **attention** list — only the things a human should actually act on;
  * the **auto-pilot** state (are all the self-maintaining ticks on?).

It is strictly read-only and cheap: plain DB aggregates plus the same
`is_configured()` checks the rest of the app uses. No external API calls, no
mutations. Every count is tenant-scoped (MT-3) the same way `sync_health` is.

Actions (pause a channel, "sync now", flip who-wins) are NOT here — the Control
Center reuses the existing endpoints (`POST /api/settings/automation`,
`/api/jobs/sync-reconcile`, `/api/jobs/push-to-gcal`, `/api/properties/sync-all`,
`/api/recurring/generate-all`). This module only ever *reports*.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from database.models import (
    Job,
    IntegrationEvent,
    PropertyIcal,
    Property,
    RecurringSchedule,
    ScheduleEvent,
)
from utils.dates import business_today

# Active = a job that still expects to reach the calendar / a crew. Mirrors the
# filter sync_health uses so the two surfaces can never disagree on "backlog".
_ACTIVE = ["scheduled", "in_progress"]


def _iso(dt):
    return dt.isoformat() if dt else None


def _channel_status(*, connected: bool, enabled: bool, backlog: int, failing: int) -> str:
    """The single-word state a channel card shows. Ordered by severity so the
    worst real condition wins: a disconnected backbone or a failing feed is
    'attention'; a paused channel is 'paused'; a backlog the ticks will clear on
    their own is just 'syncing'; otherwise 'ok'. Pure → unit-testable."""
    if not connected:
        return "disconnected"
    if failing:
        return "attention"
    if not enabled:
        return "paused"
    if backlog:
        return "syncing"
    return "ok"


def build_sync_overview(db: Session, org_id) -> dict:
    """Assemble the whole Sync Control Center payload. Read-only."""
    # Lazy imports: scheduling.router imports THIS module at load, so importing
    # its helpers at module top would be a cycle. By request time the router is
    # fully loaded, so these resolve fine.
    from modules.scheduling.router import (
        _app_flag,
        _sync_overall,
        find_schedule_issues,
    )
    from modules.auth.router import resolve_org_id
    from config import env_int, env_flag

    oid = resolve_org_id(org_id, db)
    today = business_today().isoformat()

    def _job_scoped(q):
        return q.filter(or_(Job.org_id == oid, Job.org_id.is_(None)))

    # ---- connectivity + automation flags -------------------------------------
    try:
        from integrations.google_calendar import is_configured as _g_ok
        g_connected = bool(_g_ok())
    except Exception:
        g_connected = False

    from integrations.gcal_sync import calendar_source_of_truth

    gcal_enabled = _app_flag(db, "gcal_auto_sync_enabled", "GCAL_AUTO_SYNC_ENABLED")
    ical_enabled = _app_flag(db, "ical_auto_sync_enabled", "ICAL_AUTO_SYNC_ENABLED")
    recurring_enabled = _app_flag(db, "recurring_auto_generate_enabled", "RECURRING_AUTO_GENERATE_ENABLED")
    reconcile_enabled = _app_flag(db, "sync_reconcile_enabled", "SYNC_RECONCILE_ENABLED")
    source_of_truth = calendar_source_of_truth(db)  # "brightbase" | "google"

    # ---- Google Calendar (outbound) ------------------------------------------
    unsynced_gcal = (
        _job_scoped(db.query(Job).filter(
            Job.gcal_event_id.is_(None),
            Job.status.in_(_ACTIVE),
            Job.scheduled_date >= today,
        )).count()
        if g_connected else 0
    )
    gcal_last = db.query(func.max(IntegrationEvent.created_at)).filter(
        IntegrationEvent.provider == "gcal",
        or_(IntegrationEvent.org_id == oid, IntegrationEvent.org_id.is_(None)),
    ).scalar()

    google = {
        "key": "google",
        "name": "Google Calendar",
        "icon": "calendar",
        "direction": "out" if source_of_truth == "brightbase" else "two_way",
        "authority": "brightbase" if source_of_truth == "brightbase" else "google",
        "connected": g_connected,
        "enabled": bool(gcal_enabled),
        "toggle_key": "gcal_auto_sync_enabled",
        "last_sync_at": _iso(gcal_last),
        "backlog": unsynced_gcal,
        "sync_action": "gcal",
        "status": _channel_status(connected=g_connected, enabled=bool(gcal_enabled),
                                  backlog=unsynced_gcal, failing=0),
        "summary": (
            "Not connected" if not g_connected
            else f"{unsynced_gcal} job{'s' if unsynced_gcal != 1 else ''} waiting to push"
            if unsynced_gcal else "Every job is on Google"
        ),
    }

    # ---- Connecteam (retired) ------------------------------------------------
    # Connecteam removal (step 3): nothing pushes shifts anymore — no drain
    # tick, no reconcile half, no inline/recurring/iCal dispatch. The card
    # stays as an explicit, static "retired" marker (not a silently vanished
    # channel) until the integration is deleted outright; no Connecteam-related
    # queries run for it.
    connecteam = {
        "key": "connecteam",
        "name": "Connecteam",
        "icon": "users",
        "direction": "out",
        "authority": "brightbase",
        "connected": False,
        "enabled": False,
        "toggle_key": None,
        "last_sync_at": None,
        "backlog": 0,
        "sync_action": None,
        "status": "retired",
        "summary": "Retired — the crew schedule and time clock are native (My Day)",
    }

    # ---- Airbnb / VRBO iCal feeds (inbound) ----------------------------------
    feed_rows = (
        db.query(PropertyIcal, Property.name)
        .join(Property, PropertyIcal.property_id == Property.id)
        .filter(
            PropertyIcal.active.is_(True),
            or_(PropertyIcal.org_id == oid, PropertyIcal.org_id.is_(None)),
        )
        .order_by(PropertyIcal.last_sync_status.desc().nullslast(),
                  PropertyIcal.last_synced_at.desc().nullslast())
        .all()
    )
    feeds = []
    feed_failing = 0
    feed_last = None
    for ical, prop_name in feed_rows:
        st = ical.last_sync_status
        if st in ("failed", "retrying"):
            feed_failing += 1
        if ical.last_synced_at and (feed_last is None or ical.last_synced_at > feed_last):
            feed_last = ical.last_synced_at
        feeds.append({
            "id": ical.id,
            "property_id": ical.property_id,
            "property": prop_name or f"Property #{ical.property_id}",
            "source": ical.source or "ical",
            "last_synced_at": _iso(ical.last_synced_at),
            "status": st or "pending",
            "error": ical.last_sync_error if st in ("failed", "retrying") else None,
        })

    turnovers_upcoming = _job_scoped(db.query(Job).filter(
        Job.ical_event_id.isnot(None),
        Job.status.in_(_ACTIVE),
        Job.scheduled_date >= today,
    )).count()

    airbnb = {
        "key": "airbnb",
        "name": "Airbnb & rentals",
        "icon": "home",
        "direction": "in",
        "authority": "external",  # the feed owns the checkout dates
        "connected": len(feeds) > 0,
        "enabled": bool(ical_enabled),
        "toggle_key": "ical_auto_sync_enabled",
        "last_sync_at": _iso(feed_last),
        "backlog": feed_failing,
        "feed_count": len(feeds),
        "feeds": feeds,
        "turnovers_upcoming": turnovers_upcoming,
        "sync_action": "ical",
        "status": _channel_status(connected=len(feeds) > 0, enabled=bool(ical_enabled),
                                  backlog=0, failing=feed_failing),
        "summary": (
            "No feeds connected" if not feeds
            else f"{feed_failing} feed{'s' if feed_failing != 1 else ''} need attention"
            if feed_failing else f"{len(feeds)} feed{'s' if len(feeds) != 1 else ''}, "
            f"{turnovers_upcoming} upcoming turnover{'s' if turnovers_upcoming != 1 else ''}"
        ),
    }

    # ---- Recurring generation (internal) -------------------------------------
    active_series = db.query(func.count(RecurringSchedule.id)).filter(
        RecurringSchedule.active.is_(True),
        or_(RecurringSchedule.org_id == oid, RecurringSchedule.org_id.is_(None)),
    ).scalar() or 0
    upcoming_recurring = _job_scoped(db.query(Job).filter(
        Job.recurring_schedule_id.isnot(None),
        Job.status.in_(_ACTIVE),
        Job.scheduled_date >= today,
    )).count()
    # No stored "last generated" column — the newest recurring-linked job's
    # creation time is the best available proxy for when generation last ran.
    recurring_last = _job_scoped(db.query(func.max(Job.created_at)).filter(
        Job.recurring_schedule_id.isnot(None),
    )).scalar()

    recurring = {
        "key": "recurring",
        "name": "Recurring cleanings",
        "icon": "repeat",
        "direction": "internal",
        "authority": "brightbase",
        "connected": active_series > 0,
        "enabled": bool(recurring_enabled),
        "toggle_key": "recurring_auto_generate_enabled",
        "last_sync_at": _iso(recurring_last),
        "backlog": 0,
        "active_series": int(active_series),
        "upcoming_visits": upcoming_recurring,
        "sync_action": "recurring",
        "status": _channel_status(connected=active_series > 0, enabled=bool(recurring_enabled),
                                  backlog=0, failing=0),
        "summary": (
            "No active series" if not active_series
            else "Auto-generate is off" if not recurring_enabled
            else f"{active_series} series · {upcoming_recurring} visits scheduled"
        ),
    }

    channels = [google, connecteam, airbnb, recurring]

    # ---- The background jobs ("the hidden hands"), finally visible -----------
    def _m(env, default):  # cadence in minutes
        return env_int(env, default)

    background_jobs = [
        {"key": "gcal_sync", "name": "Push the schedule to Google", "group": "scheduling",
         "cadence_minutes": _m("GCAL_AUTO_SYNC_INTERVAL_MINUTES", 10), "enabled": bool(gcal_enabled)},
        {"key": "ical_sync", "name": "Pull Airbnb / VRBO turnovers", "group": "scheduling",
         "cadence_minutes": _m("ICAL_AUTO_SYNC_INTERVAL_MINUTES", 15), "enabled": bool(ical_enabled)},
        {"key": "sync_reconcile", "name": "Reconcile the Google calendar", "group": "scheduling",
         "cadence_minutes": _m("SYNC_RECONCILE_INTERVAL_MINUTES", 30), "enabled": bool(reconcile_enabled)},
        # (connecteam_drain retired in Connecteam-removal step 3 — tick 14 → 13.)
        {"key": "recurring", "name": "Generate upcoming recurring visits", "group": "scheduling",
         "cadence_minutes": _m("RECURRING_AUTO_GENERATE_INTERVAL_HOURS", 24) * 60, "enabled": bool(recurring_enabled)},
        {"key": "str_autoassign", "name": "Auto-assign turnover crews", "group": "scheduling",
         "cadence_minutes": _m("STR_TURNOVER_AUTOASSIGN_INTERVAL_MINUTES", 30),
         # Registered only when STR_TURNOVER_AUTOASSIGN_ENABLED is on (defaults
         # OFF) — report the real state, not a green job that isn't running.
         "enabled": bool(_app_flag(db, "str_turnover_autoassign_enabled",
                                   "STR_TURNOVER_AUTOASSIGN_ENABLED", False))},
        {"key": "schedule_audit", "name": "Audit for duplicates & orphaned shifts", "group": "health",
         "cadence_minutes": _m("SCHEDULE_AUDIT_INTERVAL_HOURS", 6) * 60, "enabled": True},
        {"key": "turnover_coverage", "name": "Turnover coverage check", "group": "health",
         "cadence_minutes": 24 * 60, "enabled": True},
        {"key": "sms_reminders", "name": "Text customers their reminders", "group": "messaging",
         "cadence_minutes": _m("JOB_SMS_REMINDER_INTERVAL_MINUTES", 60), "enabled": True},
        {"key": "gmail_inbox", "name": "Pull new customer emails", "group": "messaging",
         "cadence_minutes": _m("GMAIL_AUTO_SYNC_INTERVAL_MINUTES", 10), "enabled": True},
        {"key": "dunning", "name": "Chase overdue invoices", "group": "messaging",
         "cadence_minutes": _m("JOB_DUNNING_INTERVAL_HOURS", 24) * 60, "enabled": True},
        {"key": "quote_expiry", "name": "Expire stale quotes", "group": "other",
         "cadence_minutes": 24 * 60, "enabled": True},
        {"key": "gcal_watch", "name": "Renew Google push channel", "group": "other",
         "cadence_minutes": _m("GCAL_WATCH_RENEW_INTERVAL_HOURS", 12) * 60, "enabled": True},
        {"key": "gmail_watch", "name": "Renew Gmail push channel", "group": "other",
         "cadence_minutes": _m("GMAIL_WATCH_RENEW_INTERVAL_HOURS", 12) * 60, "enabled": True},
    ]

    # ---- schedule_events log health (Phase 2 dual-write foundation) ----------
    # An append-only mirror of every canonical Job mutation. Dark until
    # SCHEDULE_EVENT_LOG_ENABLED flips on; read-only here. This block lets the
    # operator WATCH it capturing against real data — the R8 "verify" surface
    # before the Phase 3 reconciler ever reads the log.
    def _log_scoped(q):
        return q.filter(or_(ScheduleEvent.org_id == oid, ScheduleEvent.org_id.is_(None)))

    log_total = _log_scoped(db.query(func.count(ScheduleEvent.id))).scalar() or 0
    log_last = _log_scoped(db.query(func.max(ScheduleEvent.created_at))).scalar()
    log_24h = _log_scoped(
        db.query(func.count(ScheduleEvent.id))
        .filter(ScheduleEvent.created_at >= datetime.now(timezone.utc) - timedelta(hours=24))
    ).scalar() or 0
    log_by_type = {
        t: int(n) for t, n in _log_scoped(
            db.query(ScheduleEvent.event_type, func.count(ScheduleEvent.id))
            .group_by(ScheduleEvent.event_type)
        ).all()
    }
    schedule_log = {
        "enabled": bool(env_flag("SCHEDULE_EVENT_LOG_ENABLED", False)),
        "total": int(log_total),
        "last_event_at": _iso(log_last),
        "events_24h": int(log_24h),
        "by_type": log_by_type,
    }

    # ---- integrity issues + overall verdict ----------------------------------
    issues = find_schedule_issues(db, oid)
    dup = issues["counts"]["duplicate_groups"]
    orph = issues["counts"]["orphaned_shifts"]

    # Auto-pilot = the schedule maintains itself with zero manual pushes. Google
    # is the backbone, so a disconnected Google breaks the flow even with every
    # toggle on. (Connecteam retired in step 3 — it no longer factors in.)
    auto_flow_on = bool(
        g_connected and gcal_enabled and ical_enabled and recurring_enabled
        and reconcile_enabled
    )
    backlog_total = unsynced_gcal
    # Orphans (cancelled jobs still carrying legacy Connecteam shift ids) are
    # informational only now — nothing reads Connecteam, so they can't send a
    # cleaner anywhere, and the repair path that cleared them is retired. They
    # stay visible in `issues` but no longer drive the verdict or attention.
    overall = _sync_overall(
        duplicates=dup, orphans=0, backlog=backlog_total,
        auto_flow_on=auto_flow_on, google_connected=g_connected,
    )

    # ---- attention: only what a human should actually act on -----------------
    attention = []
    if not g_connected:
        attention.append({
            "level": "warn", "key": "google_disconnected",
            "title": "Google Calendar isn't connected",
            "detail": "Jobs can't reach the calendar until you reconnect Google.",
            "action": {"kind": "link", "label": "Open Settings", "href": "/settings"},
        })
    if feed_failing:
        attention.append({
            "level": "warn", "key": "feeds_failing",
            "title": f"{feed_failing} rental feed{'s' if feed_failing != 1 else ''} failing to import",
            "detail": "A turnover calendar returned an error on its last pull.",
            "action": {"kind": "sync", "label": "Re-pull feeds", "target": "ical"},
        })
    if dup:
        attention.append({
            "level": "warn", "key": "duplicate_jobs",
            "title": f"{dup} duplicate job{'s' if dup != 1 else ''} detected",
            "detail": "Two jobs share a property, date, and time.",
            "action": {"kind": "link", "label": "Review on Schedule", "href": "/schedule"},
        })
    if backlog_total and not auto_flow_on:
        attention.append({
            "level": "info", "key": "backlog_paused",
            "title": f"{backlog_total} job{'s' if backlog_total != 1 else ''} waiting to sync",
            "detail": "Auto-pilot is off, so these won't push on their own.",
            "action": {"kind": "sync", "label": "Sync now", "target": "reconcile"},
        })

    # ---- plain-English headline ----------------------------------------------
    if overall == "attention":
        headline = attention[0]["title"] if attention else "Something needs a look"
    elif overall == "syncing":
        headline = f"{backlog_total} item{'s' if backlog_total != 1 else ''} syncing — the next tick will clear them"
    else:
        headline = "Everything's in sync"

    return {
        "generated_at": _iso(business_today()),  # date-granular; freshness comes from channels
        "overall": overall,
        "headline": headline,
        "master": "brightbase",
        "auto_pilot": {
            "on": auto_flow_on,
            "toggles": {
                "gcal_auto_sync_enabled": bool(gcal_enabled),
                "ical_auto_sync_enabled": bool(ical_enabled),
                "recurring_auto_generate_enabled": bool(recurring_enabled),
                "sync_reconcile_enabled": bool(reconcile_enabled),
                "calendar_source_of_truth": source_of_truth,
            },
        },
        "channels": channels,
        "attention": attention,
        "issues": {"duplicate_jobs": dup, "orphaned_shifts": orph},
        "background_jobs": background_jobs,
        "schedule_log": schedule_log,
    }
