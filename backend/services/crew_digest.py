"""Crew morning digest — one push per cleaner with jobs today.

"Today: 2 jobs — first at 9:00 AM, 12 Oak St." at ~7am, so nobody opens the
app to find out whether to open the app.

R1-compliant: this is NOT a new scheduler tick. It rides the existing hourly
job_sms_reminders tick (scheduler.py) as an extra task — its own gates, its
own daily marker, fully independent of the customer-SMS toggles.

Gates, in order:
  1. Web push configured at all (push_service.push_enabled()).
  2. Business-local time inside the send window (06:00–09:00) — wide enough
     that an hourly tick always lands at least one firing.
  3. AppSetting marker `crew_digest_last_sent` != today — once per day,
     org-wide. Set after a send pass even if zero pushes went out (a cleaner
     subscribing at 8am shouldn't retrigger everyone).

Best-effort by design: any failure logs and skips — a broken digest must
never take the reminders tick down with it.
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session, joinedload

from database.models import AppSetting, Job, User
from utils.dates import business_now

log = logging.getLogger("uvicorn.error")

MARKER_KEY = "crew_digest_last_sent"
WINDOW_START_HOUR = 6
WINDOW_END_HOUR = 9


def _fmt_time(t) -> str:
    if not t:
        return ""
    h, m = t.hour, t.minute
    ampm = "AM" if h < 12 else "PM"
    h12 = h % 12 or 12
    return f"{h12}:{m:02d} {ampm}" if m else f"{h12} {ampm}"


def build_crew_digests(db: Session, today) -> list[dict]:
    """[{user_id, org_id, body}] for every active cleaner with jobs today.

    Pure read — no sends, no markers — so it's directly testable."""
    cleaners = (db.query(User)
                .filter(User.role == "cleaner", User.cleaner_id.isnot(None))
                .all())
    cleaners = [u for u in cleaners
                if getattr(u, "active", True) and (u.cleaner_id or "").strip()]
    if not cleaners:
        return []
    jobs = (db.query(Job)
            .options(joinedload(Job.property))
            .filter(Job.scheduled_date == today,
                    Job.status.in_(("scheduled", "in_progress")))
            .all())
    out = []
    for u in cleaners:
        mine = sorted((j for j in jobs if u.cleaner_id in (j.cleaner_ids or [])),
                      key=lambda j: (j.start_time is None, j.start_time))
        if not mine:
            continue   # a day off should stay quiet
        first = mine[0]
        where = (first.property.name if first.property else None) or first.address or first.title
        at = _fmt_time(first.start_time)
        body = (f"{len(mine)} job{'s' if len(mine) > 1 else ''} today — "
                + (f"first at {at}, " if at else "") + f"{where}.")
        out.append({"user_id": u.id, "org_id": u.org_id, "body": body})
    return out


def send_crew_morning_digests(db: Session, now: Optional[datetime] = None) -> dict:
    """The tick-side entry point: gate, build, push, mark. Returns stats."""
    try:
        from services import push_service
        if not push_service.push_enabled():
            return {"skipped": True, "reason": "push_disabled"}
        now = now or business_now()
        if not (WINDOW_START_HOUR <= now.hour < WINDOW_END_HOUR):
            return {"skipped": True, "reason": "outside_window"}
        today = now.date()
        marker = db.query(AppSetting).filter(AppSetting.key == MARKER_KEY).first()
        if marker and (marker.value or "") == today.isoformat():
            return {"skipped": True, "reason": "already_sent"}

        digests = build_crew_digests(db, today)
        sent = 0
        for d in digests:
            try:
                sent += push_service.notify_user(
                    d["user_id"], "Your day at a glance", d["body"],
                    url="/my-day", tag=f"crew-digest-{today.isoformat()}",
                )
            except Exception:
                log.exception("crew digest push failed for user %s", d["user_id"])

        if marker:
            marker.value = today.isoformat()
        else:
            db.add(AppSetting(key=MARKER_KEY, value=today.isoformat()))
        db.commit()
        return {"skipped": False, "cleaners_with_jobs": len(digests), "pushes_sent": sent}
    except Exception as e:  # never take the host tick down
        log.exception("crew digest pass failed")
        try:
            db.rollback()
        except Exception:
            pass
        return {"error": str(e)}
