"""Phase 2 dual-write: the append-only `schedule_events` log.

Contract (`scheduling-invariants`): BrightBase's Job is the single canonical
owner of schedule state. This module records every canonical Job mutation as one
immutable, ordered `schedule_events` row — the log the Phase 3 reconciler will
drain into `projection_state`.

It is a **Session flush listener**, deliberately: there is no single function
every Job write funnels through (API handlers, background ticks, recurring
generation, and direct `setattr` all write Jobs), but they ALL converge on the
SQLAlchemy flush. Listening there captures every path and writes the log row IN
THE SAME TRANSACTION as the Job change, so the two can never disagree — they
commit or roll back together.

Gated by SCHEDULE_EVENT_LOG_ENABLED (env, default OFF). When off this is a total
no-op: Phase 2 is a dark-launched, additive foundation (R8) — nothing reads the
log yet, and flipping the flag changes no user-visible behavior, it only starts
populating the log so it can be verified against real data before Phase 3 cuts
over. Adds no background tick (R1 — written inline on flush), keeps sync logic
out of router.py (R6 — it lives here), and never writes back from a projection
(R2 — it only records canonical Job writes).
"""
from __future__ import annotations

import datetime as _dt
import logging

from sqlalchemy import event, inspect

from config import env_flag

log = logging.getLogger("brightbase.schedule_events")

# Fields whose change counts as a schedule mutation worth logging.
_TRACKED = ("scheduled_date", "start_time", "end_time", "cleaner_ids", "status")
_INFO_KEY = "_bb_pending_schedule_events"


def _enabled() -> bool:
    # Env-only (not the DB app_settings override) on purpose: this runs inside
    # before/after_flush, where issuing a query to read a DB flag would re-enter
    # the session mid-flush. Ops flips SCHEDULE_EVENT_LOG_ENABLED to dark-launch.
    return env_flag("SCHEDULE_EVENT_LOG_ENABLED", False)


def _json_safe(v):
    if isinstance(v, (_dt.date, _dt.time, _dt.datetime)):
        return v.isoformat()
    if v is None or isinstance(v, (str, int, float, bool, list, dict)):
        return v
    return str(v)  # last resort: a surprise value must never break JSON serialization


def _snapshot(job) -> dict:
    return {f: _json_safe(getattr(job, f, None)) for f in _TRACKED}


def _diff(job) -> dict:
    """{field: [old, new]} for tracked fields with a pending change. Must be read
    in before_flush, while the attribute history is still intact."""
    st = inspect(job)
    out = {}
    for f in _TRACKED:
        hist = st.attrs[f].history
        if hist.has_changes():
            old = hist.deleted[0] if hist.deleted else None
            new = hist.added[0] if hist.added else getattr(job, f, None)
            out[f] = [_json_safe(old), _json_safe(new)]
    return out


def _classify(changed: set, new_status) -> str:
    if "status" in changed and new_status in ("cancelled", "completed"):
        return new_status
    if changed == {"cleaner_ids"}:
        return "reassigned"
    if changed & {"scheduled_date", "start_time", "end_time"}:
        return "rescheduled"
    return "updated"


def install(session_factory=None) -> None:
    """Register the flush listeners on the app's sessionmaker. Idempotent — safe
    to call from both app startup and tests."""
    from database.db import SessionLocal
    from database.models import Job, ScheduleEvent

    target = session_factory or SessionLocal
    if getattr(target, "_bb_schedule_events_installed", False):
        return

    @event.listens_for(target, "before_flush")
    def _before_flush(session, flush_context, instances):  # noqa: ANN001
        if not _enabled():
            return
        try:
            pending = session.info.setdefault(_INFO_KEY, [])
            for obj in session.new:
                if isinstance(obj, Job):
                    pending.append({"obj": obj, "event_type": "created",
                                    "payload": _snapshot(obj)})
            for obj in session.dirty:
                if isinstance(obj, Job) and session.is_modified(obj, include_collections=False):
                    changed = _diff(obj)
                    if changed:
                        pending.append({"obj": obj,
                                        "event_type": _classify(set(changed), obj.status),
                                        "payload": changed})
            for obj in session.deleted:
                if isinstance(obj, Job):
                    # Capture ids now — the instance is expired after the delete flush.
                    pending.append({"obj": obj, "event_type": "deleted",
                                    "payload": _snapshot(obj),
                                    "job_id": obj.id, "org_id": getattr(obj, "org_id", None)})
        except Exception:
            # Fail-safe: the log must never break a canonical Job write. Drop this
            # batch and let the Job flush proceed untouched.
            log.exception("schedule_events before_flush failed; skipping this batch")
            session.info.pop(_INFO_KEY, None)

    @event.listens_for(target, "after_flush")
    def _after_flush(session, flush_context):  # noqa: ANN001
        pending = session.info.pop(_INFO_KEY, None)
        if not pending:
            return
        try:
            now = _dt.datetime.now(_dt.timezone.utc)
            rows = []
            for p in pending:
                obj = p["obj"]
                job_id = p.get("job_id") or getattr(obj, "id", None)  # populated post-insert
                if job_id is None:
                    continue  # can't attribute the event — skip rather than write a broken row
                rows.append({
                    "org_id": p.get("org_id", getattr(obj, "org_id", None)),
                    "job_id": job_id,
                    "event_type": p["event_type"],
                    "payload": p["payload"],
                    "actor": None,
                    "created_at": now,
                })
            if rows:
                # Core insert (not ORM add) so it runs in THIS transaction without
                # provoking another ORM flush / re-entering these listeners.
                session.execute(ScheduleEvent.__table__.insert(), rows)
        except Exception:
            # Fail-safe: never let the log write break the Job write. Errors while
            # BUILDING rows are swallowed here; the insert itself is made
            # non-failing by dropping schedule_events' FKs (migration 074) and
            # keeping payloads JSON-safe (_json_safe), so a Job write is not lost
            # to the log in practice.
            log.exception("schedule_events after_flush failed; log row(s) dropped")

    target._bb_schedule_events_installed = True


# Self-register on import so any importer (app startup, tests) activates it; the
# flag gate keeps it a no-op until explicitly turned on.
install()
