"""The Saturday window — the office side (marketplace pivot Phase 5, migration 101).

A window is the schedule and the price ladder around one service day's guest
turnovers. The office plans it, and from then on the daily tick opens the batch
and climbs the ladder on whatever nobody has taken.

Routers route (R6). Opening, stepping and closing all live in
`services/turnover_windows.py`, which the tick calls too — one definition of
the ladder, not two.

Every write here refuses to touch a job somebody has already taken. That rule
is enforced in the service, on purpose: it is the one thing that must hold no
matter which caller is asking.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import TurnoverWindow
from modules.auth.router import require_role, current_org_id, resolve_org_id
from services import turnover_windows as windows_service
from utils.dates import business_today, coerce_date

router = APIRouter()


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _get(db: Session, window_id: int, oid: int) -> TurnoverWindow:
    w = (db.query(TurnoverWindow)
         .filter(TurnoverWindow.id == window_id,
                 or_(TurnoverWindow.org_id == oid, TurnoverWindow.org_id.is_(None)))
         .first())
    if w is None:
        raise HTTPException(status_code=404, detail="Window not found.")
    return w


class WindowBody(BaseModel):
    service_date: Optional[str] = None
    base_rate: Optional[float] = None
    step_pct: Optional[float] = None
    max_steps: Optional[int] = None
    open_days_before: Optional[int] = None
    first_step_days_before: Optional[int] = None
    notes: Optional[str] = None


def _apply(w: TurnoverWindow, body: WindowBody) -> None:
    if body.base_rate is not None:
        if float(body.base_rate) < 0:
            raise HTTPException(status_code=422, detail="A rate can't be negative.")
        w.base_rate = float(body.base_rate)
    if body.step_pct is not None:
        if not 0 <= float(body.step_pct) <= 100:
            raise HTTPException(status_code=422,
                                detail="A step is a percentage between 0 and 100.")
        w.step_pct = float(body.step_pct)
    if body.max_steps is not None:
        if not 0 <= int(body.max_steps) <= 10:
            raise HTTPException(status_code=422, detail="Cap the ladder at 10 steps or fewer.")
        w.max_steps = int(body.max_steps)
    if body.open_days_before is not None:
        w.open_days_before = max(0, int(body.open_days_before))
    if body.first_step_days_before is not None:
        w.first_step_days_before = max(0, int(body.first_step_days_before))
    if body.notes is not None:
        w.notes = body.notes or None


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def list_windows(days: int = Query(60, ge=1, le=365),
                 db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id)):
    """Upcoming windows and how each day is actually going.

    One request draws the screen, coverage numbers included — the point of
    looking is "is Saturday a problem", and a list that made you open each one
    to find out would be the wrong shape.
    """
    from datetime import timedelta

    oid = resolve_org_id(org_id, db)
    today = business_today()
    rows = (db.query(TurnoverWindow)
            .filter(or_(TurnoverWindow.org_id == oid, TurnoverWindow.org_id.is_(None)),
                    TurnoverWindow.service_date >= today - timedelta(days=7),
                    TurnoverWindow.service_date <= today + timedelta(days=days))
            .order_by(TurnoverWindow.service_date)
            .all())
    return {"windows": [windows_service.window_state(db, w) for w in rows]}


@router.post("", dependencies=[Depends(require_role("admin", "manager"))])
def create_window(body: WindowBody, db: Session = Depends(get_db),
                  org_id: int = Depends(current_org_id)):
    """Plan a service day. Nothing is posted until it opens.

    A second window for a date that already has one is refused rather than
    created: two ladders on one Saturday would step the same jobs twice, and
    the unique constraint would refuse it anyway — this just says so in words.
    """
    oid = resolve_org_id(org_id, db)
    d = coerce_date(body.service_date)
    if d is None:
        raise HTTPException(status_code=422, detail="Pick a service date (YYYY-MM-DD).")

    existing = (db.query(TurnoverWindow)
                .filter(TurnoverWindow.service_date == d,
                        or_(TurnoverWindow.org_id == oid, TurnoverWindow.org_id.is_(None)))
                .first())
    if existing is not None:
        raise HTTPException(status_code=409,
                            detail=f"There's already a window for {d.isoformat()}.")

    w = TurnoverWindow(org_id=oid, service_date=d, status="pending",
                       created_at=_now(), updated_at=_now())
    _apply(w, body)
    db.add(w); db.commit(); db.refresh(w)
    return windows_service.window_state(db, w)


@router.get("/{window_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_window(window_id: int, db: Session = Depends(get_db),
               org_id: int = Depends(current_org_id)):
    return windows_service.window_state(db, _get(db, window_id, resolve_org_id(org_id, db)))


@router.patch("/{window_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_window(window_id: int, body: WindowBody, db: Session = Depends(get_db),
                  org_id: int = Depends(current_org_id)):
    """Edit the ladder.

    Editing does NOT reprice jobs already posted — the rate on the board is
    what people are looking at, and silently moving it under them is how a
    claim gets made against a number that no longer exists. The new settings
    take effect at the next step. Lowering `max_steps` below where the ladder
    already is simply stops it climbing further.
    """
    w = _get(db, window_id, resolve_org_id(org_id, db))
    _apply(w, body)
    w.updated_at = _now()
    db.commit(); db.refresh(w)
    return windows_service.window_state(db, w)


@router.post("/{window_id}/open", dependencies=[Depends(require_role("admin", "manager"))])
def open_now(window_id: int, db: Session = Depends(get_db),
             org_id: int = Depends(current_org_id)):
    """Post this day's turnovers to the bench now, ahead of schedule.

    Safe to press twice: jobs somebody has already taken are skipped, and the
    response says how many.
    """
    w = _get(db, window_id, resolve_org_id(org_id, db))
    if w.status == "closed":
        raise HTTPException(status_code=409, detail="This window is closed.")
    result = windows_service.open_window(db, w)
    return {**windows_service.window_state(db, w), "just_opened": result["opened"],
            "already_taken": result["already_taken"]}


@router.post("/{window_id}/step", dependencies=[Depends(require_role("admin"))])
def step_now(window_id: int, db: Session = Depends(get_db),
             org_id: int = Depends(current_org_id)):
    """Raise the price on what's left, now, without waiting for tomorrow.

    Refused at the ceiling and refused twice in one day — the same rules the
    tick obeys, because it is the same function.
    """
    w = _get(db, window_id, resolve_org_id(org_id, db))
    result = windows_service.step_window(db, w)
    if not result.get("stepped"):
        raise HTTPException(status_code=409, detail=result.get("reason", "Can't step this one."))
    return windows_service.window_state(db, w)


@router.post("/{window_id}/close", dependencies=[Depends(require_role("admin", "manager"))])
def close_now(window_id: int, db: Session = Depends(get_db),
              org_id: int = Depends(current_org_id)):
    """Stop the ladder. Unclaimed turnovers stay on the board at whatever they
    reached — somebody taking one late still beats nobody taking it."""
    return windows_service.close_window(db, _get(db, window_id, resolve_org_id(org_id, db)))


@router.delete("/{window_id}", dependencies=[Depends(require_role("admin"))])
def delete_window(window_id: int, db: Session = Depends(get_db),
                  org_id: int = Depends(current_org_id)):
    """Delete a window that never opened.

    An opened window is the record of what was posted and at what price. It
    gets closed, not erased — and deleting it would not un-post the jobs
    anyway, which is the more misleading half.
    """
    w = _get(db, window_id, resolve_org_id(org_id, db))
    if w.status != "pending":
        raise HTTPException(
            status_code=409,
            detail="This window has already opened. Close it instead — the jobs stay posted either way.")
    db.delete(w); db.commit()
    return {"deleted": window_id}
