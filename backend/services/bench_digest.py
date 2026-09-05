"""The Wednesday digest: what the bench is doing, once a week, in one message.

Everything the marketplace pivot added reports somewhere — the payout ledger,
the vetting review, the turnover windows, the routes page. Five screens, each
of which has to be remembered and opened. Nobody opens five screens on a
Wednesday, so the parts that need a decision get found on Friday instead, which
is when they are expensive.

This is the one message that asks for the week's decisions together:

  * turnovers still uncovered, soonest first — the thing that ruins a weekend;
  * routes offered and not yet answered — a sub who hasn't looked, or has and
    isn't saying;
  * files expiring within the month — an insurance certificate that lapses is
    a person who silently can't work;
  * payouts sitting due — money owed and not sent;
  * subs approaching the $600 mark, once each per year.

WHY WEDNESDAY. The Saturday windows open around ten days out and start climbing
about four days out, so Wednesday is the last point where a gap can be fixed by
posting or by pricing rather than by phoning people. A Friday digest would only
report what already went wrong.

SILENT WHEN THERE'S NOTHING. A weekly message that arrives whether or not it
matters is a weekly message nobody opens — and then the week it matters, it is
in a folder with the others. If nothing needs a decision, nothing is sent.

Rides the existing schedule-audit tick (R1). No new background job.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Job, Route, SubPayout, TurnoverWindow, User
from utils.dates import business_today

logger = logging.getLogger(__name__)

MODE_KEY = "bench_digest_enabled"
DAY_KEY = "bench_digest_weekday"          # 0=Mon … 6=Sun; 2 = Wednesday
MARKER_KEY = "bench_digest_last_sent"     # ISO date, so a restart can't re-send

# How far ahead each section looks. Turnovers are the short horizon because
# they're the thing you can still act on; documents are the long one because
# renewing insurance takes weeks.
TURNOVER_HORIZON_DAYS = 14
DOCUMENT_HORIZON_DAYS = 30


def _scope(model, org_id: int):
    return or_(model.org_id == org_id, model.org_id.is_(None))


def build(db: Session, org_id: int, today: Optional[date] = None) -> dict:
    """Everything worth a decision this week. Read-only.

    Sections that are empty are simply absent from `lines`, so the message is
    as short as the week deserves.
    """
    today = today or business_today()
    lines, sections = [], {}

    # ── Turnovers nobody has taken ──────────────────────────────────────────
    horizon = today + timedelta(days=TURNOVER_HORIZON_DAYS)
    open_turnovers = (db.query(Job)
                      .filter(Job.job_type == "str_turnover",
                              Job.scheduled_date >= today,
                              Job.scheduled_date <= horizon,
                              Job.status.notin_(["cancelled", "completed"]),
                              _scope(Job, org_id))
                      .order_by(Job.scheduled_date)
                      .all())
    uncovered = [j for j in open_turnovers if not (j.cleaner_ids or []) and not j.agreed_rate]
    sections["uncovered_turnovers"] = [
        {"job_id": j.id, "date": j.scheduled_date.isoformat() if j.scheduled_date else None,
         "title": j.title, "posted_rate": j.posted_rate,
         "on_the_board": bool(j.open_for_claims)}
        for j in uncovered]
    if uncovered:
        soonest = uncovered[0].scheduled_date
        not_posted = sum(1 for j in uncovered if not j.open_for_claims)
        line = (f"{len(uncovered)} turnover{'' if len(uncovered) == 1 else 's'} "
                f"with nobody on {'it' if len(uncovered) == 1 else 'them'}, "
                f"soonest {soonest.isoformat() if soonest else 'unscheduled'}")
        if not_posted:
            # The actionable half: something nobody can claim because it was
            # never put on the board.
            line += f" — {not_posted} not even posted to the bench"
        lines.append(line)

    # ── Routes offered and unanswered ───────────────────────────────────────
    offered = (db.query(Route)
               .filter(Route.status == "offered", _scope(Route, org_id))
               .order_by(Route.offered_at)
               .all())
    sections["routes_awaiting"] = [
        {"route_id": r.id, "name": r.name, "cleaner_id": r.owner_cleaner_id,
         "offered_at": r.offered_at.isoformat() if r.offered_at else None}
        for r in offered]
    if offered:
        lines.append(f"{len(offered)} route{'' if len(offered) == 1 else 's'} "
                     f"offered and not answered yet")

    # ── Files about to lapse ────────────────────────────────────────────────
    from services.sub_vetting import expiring_documents
    expiring = expiring_documents(db, org_id, within_days=DOCUMENT_HORIZON_DAYS)
    names = {}
    if expiring:
        ids = {e["user_id"] for e in expiring}
        names = {u.id: (u.full_name or u.email)
                 for u in db.query(User).filter(User.id.in_(ids)).all()}
    sections["expiring_documents"] = [{**e, "name": names.get(e["user_id"])}
                                      for e in expiring]
    already_expired = [e for e in expiring if e["expired"]]
    if already_expired:
        # Stated separately and first: an expired certificate is somebody who
        # cannot work right now, which is a different problem from one that
        # will need renewing.
        lines.append(f"{len(already_expired)} document"
                     f"{'' if len(already_expired) == 1 else 's'} already expired — "
                     "those subs can't take work until it's replaced")
    soon = [e for e in expiring if not e["expired"]]
    if soon:
        lines.append(f"{len(soon)} document{'' if len(soon) == 1 else 's'} "
                     f"expiring within {DOCUMENT_HORIZON_DAYS} days")

    # ── Money owed ──────────────────────────────────────────────────────────
    due = (db.query(SubPayout)
           .filter(SubPayout.status == "due", _scope(SubPayout, org_id))
           .all())
    due_total = round(sum(float(p.amount or 0.0) for p in due), 2)
    sections["payouts_due"] = {"count": len(due), "total": due_total}
    if due:
        lines.append(f"${due_total:,.2f} owed to subcontractors and not sent "
                     f"({len(due)} payout{'' if len(due) == 1 else 's'})")

    # ── The 1099 line ───────────────────────────────────────────────────────
    from services.sub_payouts import year_to_date
    ytd = year_to_date(db, org_id, today.year)
    over = [s for s in ytd["subs"] if s["over_1099_threshold"]]
    sections["over_1099"] = over
    if over:
        lines.append(f"{len(over)} subcontractor{'' if len(over) == 1 else 's'} "
                     f"past $600 this year — they'll need a 1099")

    return {"as_of": today.isoformat(), "lines": lines, "sections": sections,
            "empty": not lines}


def _flag(db: Session, key: str, default: bool) -> bool:
    from modules.settings.router import get_setting
    raw = get_setting(db, key)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _weekday(db: Session) -> int:
    from modules.settings.router import get_setting
    try:
        val = int(get_setting(db, DAY_KEY))
    except (TypeError, ValueError):
        return 2                       # Wednesday
    return val if 0 <= val <= 6 else 2


def due_today(db: Session, today: Optional[date] = None) -> bool:
    """Is today the day, and hasn't it already gone out.

    The marker is a date, not a boolean: the tick runs every few minutes, and
    a redeploy at 9:05 must not send a second copy of a digest that went at
    9:00. Same reasoning as the crew morning digest's once-per-day marker.
    """
    from modules.settings.router import get_setting

    today = today or business_today()
    if not _flag(db, MODE_KEY, False):
        return False
    if today.weekday() != _weekday(db):
        return False
    return (get_setting(db, MARKER_KEY) or "") != today.isoformat()


def send(db: Session, org_id: int, today: Optional[date] = None) -> dict:
    """Build it and push it, once. Marks the day even when nothing was sent.

    Marking a silent week is deliberate: without it the tick would rebuild the
    digest on every run all Wednesday, which is a handful of queries a minute
    to decide, repeatedly, that there is nothing to say.
    """
    from modules.settings.router import set_setting

    today = today or business_today()
    digest = build(db, org_id, today)
    set_setting(db, MARKER_KEY, today.isoformat())
    db.commit()

    if digest["empty"]:
        return {"sent": False, "reason": "nothing to report", **digest}

    try:
        from services.push_service import notify_staff
        notify_staff(
            db, "This week on the bench",
            " · ".join(digest["lines"]),
            url="/turnovers", tag=f"bench-digest-{today.isoformat()}",
            org_id=org_id, category="ops",
        )
    except Exception:
        logger.exception("[bench-digest] push failed")
        return {"sent": False, "reason": "push failed", **digest}
    return {"sent": True, **digest}
