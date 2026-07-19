"""Two-way Connecteam schedule sync (Connecteam → BrightBase direction).

BrightBase has always pushed shifts TO Connecteam (connecteam_auto.py) but never
read them back, so a change made *inside* Connecteam — moving a shift, deleting
it, reassigning a cleaner — silently drifted the two apart. Now that we can read
Connecteam shifts (integrations.connecteam.get_scheduled_shifts), this module
closes the loop: it reads Connecteam, compares each linked shift to the job, and
tells the operator what changed — guided, not silent, so a stray Connecteam edit
can never quietly cancel or move a real job.

How we tell WHICH SIDE changed: every successful push stores a snapshot of what
went out (Job.connecteam_synced_schedule). Comparing three things —
  * synced  = what we last pushed
  * job_now = the job's current schedule
  * ct_now  = what Connecteam reports now
lets us classify:
  * ct_now != synced, job_now == synced → changed in Connecteam  (offer: pull)
  * ct_now != synced, job_now != synced → conflict               (offer: choose)
  * shift missing from Connecteam        → deleted in Connecteam  (offer: cancel/re-push)

Timestamps round-trip cleanly because the push path treats naive job times as
UTC (integrations.connecteam._to_epoch_seconds), so reversing a Connecteam epoch
with fromtimestamp(..., utc) yields exactly the wall-clock we pushed.
"""
import logging
from datetime import datetime, timezone, date, time

from integrations.connecteam import get_scheduled_shifts, is_configured, ConnecteamAuthError
from integrations.connecteam_auto import (
    _job_schedule_snapshot, resync_job, remove_job_from_connecteam,
)

logger = logging.getLogger(__name__)

# A job still "lives" (should mirror Connecteam) unless it's reached a terminal
# state. Checking the terminal set is more robust than whitelisting every active
# status the app might use.
_TERMINAL = ("cancelled", "completed")


def _is_active(job) -> bool:
    return job.status not in _TERMINAL


def _ct_snapshot(shift: dict) -> dict:
    """Reverse a Connecteam shift's epoch times into the same {scheduled_date,
    start_time, end_time} shape Job snapshots use, so they compare directly."""
    def parts(ts):
        if not ts:
            return None, None
        dt = datetime.fromtimestamp(int(ts), timezone.utc)
        return dt.date().isoformat(), dt.strftime("%H:%M:%S")
    sd, st = parts(shift.get("startTimestamp"))
    _, et = parts(shift.get("endTimestamp"))
    return {"scheduled_date": sd, "start_time": st, "end_time": et}


def _ct_times(shift: dict):
    """(date, start_time, end_time) as python objects for writing onto a Job."""
    s = datetime.fromtimestamp(int(shift["startTimestamp"]), timezone.utc)
    e = datetime.fromtimestamp(int(shift["endTimestamp"]), timezone.utc)
    return s.date(), s.time().replace(microsecond=0), e.time().replace(microsecond=0)


async def detect_schedule_drift(db, jobs, start_date: str, end_date: str) -> dict:
    """Compare Connecteam's live shifts to ``jobs`` (caller-supplied, already
    windowed) and return a list of differences for review. Read-only.

    Returns { "changes": [ {type, job_id, title, shift_ids, brightbase, connecteam,
    note} ], "unlinked_count": int, "checked": int }."""
    if not is_configured():
        return {"changes": [], "unlinked_count": 0, "checked": 0, "reason": "not_configured"}

    ct_shifts = await get_scheduled_shifts(start_date, end_date)
    ct_by_id = {str(s["id"]): s for s in ct_shifts if s.get("id")}
    linked_ids = set()
    changes = []

    for job in jobs:
        if not job.connecteam_shift_ids or not _is_active(job):
            continue
        sids = [str(s) for s in job.connecteam_shift_ids]
        for sid in sids:
            linked_ids.add(sid)
        present = [sid for sid in sids if sid in ct_by_id]
        missing = [sid for sid in sids if sid not in ct_by_id]

        bb = {
            "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None,
            "start_time": str(job.start_time)[:5] if job.start_time else None,
            "end_time": str(job.end_time)[:5] if job.end_time else None,
            "cleaner_ids": [str(c) for c in (job.cleaner_ids or [])],
        }

        if not present:
            changes.append({
                "type": "deleted_in_connecteam",
                "job_id": job.id, "title": job.title, "shift_ids": sids,
                "brightbase": bb, "connecteam": None,
                "note": "Every Connecteam shift for this job is gone.",
            })
            continue

        ct = ct_by_id[present[0]]
        ct_snap = _ct_snapshot(ct)
        synced = job.connecteam_synced_schedule
        job_now = _job_schedule_snapshot(job)
        ct_changed = bool(synced) and any(
            ct_snap.get(k) != synced.get(k) for k in ("scheduled_date", "start_time", "end_time")
        )
        bb_changed = bool(synced) and job_now != synced

        ct_users = sorted(str(u) for u in (ct.get("assignedUserIds") or []))
        assign_changed = ct_users and ct_users != sorted(bb["cleaner_ids"])

        ct_out = {
            "scheduled_date": ct_snap["scheduled_date"],
            "start_time": (ct_snap["start_time"] or "")[:5],
            "end_time": (ct_snap["end_time"] or "")[:5],
            "cleaner_ids": ct_users,
            "title": ct.get("title") or "",
        }

        if ct_changed and bb_changed:
            kind = "conflict"
        elif ct_changed:
            kind = "changed_in_connecteam"
        elif assign_changed:
            kind = "reassigned_in_connecteam"
        elif missing:
            kind = "partially_deleted_in_connecteam"
        else:
            continue  # in sync (or only BB changed — the push path handles that)

        note = None
        if missing:
            note = f"{len(missing)} of {len(sids)} shifts removed in Connecteam."
        changes.append({
            "type": kind,
            "job_id": job.id, "title": job.title, "shift_ids": sids,
            "brightbase": bb, "connecteam": ct_out, "note": note,
        })

    unlinked = [s for sid, s in ct_by_id.items() if sid not in linked_ids and not s.get("isOpenShift")]
    return {
        "changes": changes,
        "unlinked_count": len(unlinked),
        "checked": len([j for j in jobs if j.connecteam_shift_ids and _is_active(j)]),
    }


def apply_drift_action(db, job, shift, action: str) -> dict:
    """Guided one-click resolution for a drift item. `shift` is the current
    Connecteam shift dict for the job (or None if it was deleted).

      * pull   — adopt Connecteam's time on the BrightBase job (they made the
                 change in Connecteam and it's correct). Updates the synced
                 snapshot so the item clears; does NOT re-push.
      * repush — keep BrightBase's version; delete+recreate the Connecteam
                 shift(s) so Connecteam matches BrightBase again.
      * cancel — accept that the work is gone; cancel the job and pull its
                 Connecteam shifts.
    """
    if action == "pull":
        if not shift:
            return {"ok": False, "error": "no Connecteam shift to pull from"}
        d, st, et = _ct_times(shift)
        job.scheduled_date, job.start_time, job.end_time = d, st, et
        # Now BrightBase matches Connecteam — record that as the synced baseline
        # so the drift detector sees them as in sync (and don't re-push).
        job.connecteam_synced_schedule = _job_schedule_snapshot(job)
        try:
            db.commit(); db.refresh(job)
        except Exception as e:  # pragma: no cover
            db.rollback()
            return {"ok": False, "error": str(e)}
        return {"ok": True, "applied": "pull"}

    if action == "repush":
        st = resync_job(db, job)
        return {"ok": bool(st.get("dispatched")), "applied": "repush", "detail": st}

    if action == "cancel":
        job.status = "cancelled"
        remove_job_from_connecteam(db, job, commit=False)
        job.connecteam_synced_schedule = None
        try:
            db.commit(); db.refresh(job)
        except Exception as e:  # pragma: no cover
            db.rollback()
            return {"ok": False, "error": str(e)}
        return {"ok": True, "applied": "cancel"}

    return {"ok": False, "error": f"unknown action '{action}'"}
