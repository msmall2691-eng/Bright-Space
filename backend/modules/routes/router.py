"""Routes — the office side (marketplace pivot Phase 4, migration 100).

A route is a standing block of recurring work owned by one subcontractor at
one rate. The office builds it, prices it, and OFFERS it. It never assigns it:
the sub's acceptance is what makes a route active, and that control point is
the same one the marketplace claim provides — a route somebody can decline is
work they chose, which is what keeps them a contractor rather than an employee
with a nicer job title.

Routers route (scheduling-invariants R6). The rate split, the offer rules, the
membership rules and the conflict lookup all live in `services/routes.py`;
what's here is parsing, org-scoping, role gates, and shaping plain dicts.

WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN: any path that gives a route an
owner without that person accepting it. `offer` names an intended owner and
sets a status. `accept` (on the crew router) is the only thing that moves a
route to `active`.
"""
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Route, RouteMember, User
from modules.auth.router import require_role, current_org_id, resolve_org_id
from services import routes as routes_service
from services.sub_vetting import missing_requirements

router = APIRouter()


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _scope(model, oid: int):
    return or_(model.org_id == oid, model.org_id.is_(None))


def _get(db: Session, route_id: int, oid: int) -> Route:
    route = db.query(Route).filter(Route.id == route_id, _scope(Route, oid)).first()
    if route is None:
        raise HTTPException(status_code=404, detail="Route not found.")
    return route


def _cleaner_by_crew_id(db: Session, cleaner_id: str, oid: int) -> Optional[User]:
    if not cleaner_id:
        return None
    return (db.query(User)
            .filter(User.cleaner_id == cleaner_id, _scope(User, oid))
            .first())


class RouteBody(BaseModel):
    name: Optional[str] = None
    day_of_week: Optional[int] = None
    rate: Optional[float] = None
    backup_cleaner_id: Optional[str] = None
    schedule_ids: Optional[List[int]] = None


class OfferBody(BaseModel):
    cleaner_id: str


class EndBody(BaseModel):
    reason: Optional[str] = None


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def list_routes(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Every route, with its owner's name and how many houses it holds.

    One request draws the list (brightbase-economy): names are resolved in a
    single lookup rather than one per row.
    """
    oid = resolve_org_id(org_id, db)
    rows = (db.query(Route).filter(_scope(Route, oid))
            .order_by(Route.day_of_week, Route.name).all())
    crew_ids = {r.owner_cleaner_id for r in rows if r.owner_cleaner_id}
    names = {}
    if crew_ids:
        names = {u.cleaner_id: (u.full_name or u.email)
                 for u in db.query(User).filter(User.cleaner_id.in_(crew_ids),
                                                _scope(User, oid)).all()}
    out = []
    for r in rows:
        d = routes_service.route_dict(db, r)
        d["owner_name"] = names.get(r.owner_cleaner_id)
        out.append(d)
    return {"routes": out}


@router.post("", dependencies=[Depends(require_role("admin", "manager"))])
def create_route(body: RouteBody, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id)):
    """Start a route as a DRAFT. Generation ignores drafts entirely, so a
    half-built route can sit here without touching anybody's calendar."""
    oid = resolve_org_id(org_id, db)
    if not (body.name or "").strip():
        raise HTTPException(status_code=422, detail="Give the route a name.")
    if body.day_of_week is None or not 0 <= int(body.day_of_week) <= 6:
        raise HTTPException(status_code=422, detail="Pick a day of the week.")

    route = Route(org_id=oid, name=body.name.strip(),
                  day_of_week=int(body.day_of_week),
                  rate=body.rate, backup_cleaner_id=body.backup_cleaner_id,
                  status="draft", created_at=_now(), updated_at=_now())
    db.add(route)
    db.flush()
    if body.schedule_ids is not None:
        try:
            routes_service.set_members(db, route, body.schedule_ids, oid)
        except ValueError as e:
            db.rollback()
            raise HTTPException(status_code=409, detail=str(e))
    db.commit(); db.refresh(route)
    return routes_service.route_dict(db, route, with_members=True)


@router.get("/{route_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_route(route_id: int, db: Session = Depends(get_db),
              org_id: int = Depends(current_org_id)):
    """The route and its houses, each with the share of the block rate it
    carries — a route priced without its parts visible is a number somebody
    has to trust."""
    oid = resolve_org_id(org_id, db)
    route = _get(db, route_id, oid)
    out = routes_service.route_dict(db, route, with_members=True)
    # The margin, on the screen. A route priced without the billed total next
    # to it is a route priced by feel, and the margin is what you lose that way.
    out["billing"] = routes_service.recent_billing(db, route, oid)
    if route.owner_cleaner_id:
        u = _cleaner_by_crew_id(db, route.owner_cleaner_id, oid)
        out["owner_name"] = (u.full_name or u.email) if u else None
    return out


@router.patch("/{route_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_route(route_id: int, body: RouteBody, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id)):
    """Edit a route's name, day, rate, backup or houses.

    An ACTIVE route can be repriced, and the new rate applies to visits
    generated from here on — jobs already generated keep the `agreed_rate`
    they were created with. Never retroactively reprice work somebody has
    already been told they're doing.
    """
    oid = resolve_org_id(org_id, db)
    route = _get(db, route_id, oid)
    if route.status == "ended":
        raise HTTPException(status_code=409,
                            detail="This route has ended. Build a new one instead.")

    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status_code=422, detail="Give the route a name.")
        route.name = body.name.strip()
    if body.day_of_week is not None:
        if not 0 <= int(body.day_of_week) <= 6:
            raise HTTPException(status_code=422, detail="Pick a day of the week.")
        route.day_of_week = int(body.day_of_week)
    if body.rate is not None:
        if float(body.rate) < 0:
            raise HTTPException(status_code=422, detail="A rate can't be negative.")
        route.rate = float(body.rate)
    if body.backup_cleaner_id is not None:
        route.backup_cleaner_id = body.backup_cleaner_id or None
    if body.schedule_ids is not None:
        try:
            routes_service.set_members(db, route, body.schedule_ids, oid)
        except ValueError as e:
            db.rollback()
            raise HTTPException(status_code=409, detail=str(e))

    route.updated_at = _now()
    db.commit(); db.refresh(route)
    return routes_service.route_dict(db, route, with_members=True)


@router.get("/{route_id}/offer-check",
            dependencies=[Depends(require_role("admin", "manager"))])
def offer_check(route_id: int, cleaner_id: str, db: Session = Depends(get_db),
                org_id: int = Depends(current_org_id)):
    """What would happen if this route were offered to this person.

    Read-only, so the office sees the conflicts and the file problems BEFORE
    sending rather than by having the offer bounce. One request, because the
    answer is one decision.
    """
    oid = resolve_org_id(org_id, db)
    route = _get(db, route_id, oid)
    u = _cleaner_by_crew_id(db, cleaner_id, oid)
    return {
        "blocker": routes_service.validate_offerable(db, route),
        "cleaner_id": cleaner_id,
        "cleaner_name": (u.full_name or u.email) if u else None,
        "known": u is not None,
        # The vetting file (Phase 2). An unvetted sub can't be offered a route
        # for the same reason they can't claim a job.
        "missing": missing_requirements(db, u.id) if u else [],
        "conflicts": routes_service.upcoming_conflicts(db, route, cleaner_id, oid),
    }


@router.post("/{route_id}/offer", dependencies=[Depends(require_role("admin", "manager"))])
def offer_route(route_id: int, body: OfferBody, db: Session = Depends(get_db),
                org_id: int = Depends(current_org_id)):
    """Offer the route to one subcontractor. It is not theirs until they accept.

    Three gates, in the order that gives the most useful refusal:
      1. the route itself has to be offerable (a rate, houses, times);
      2. the person has to exist as a crew login;
      3. their file has to be complete — an uninsured person is not offered
         standing work, and finding that out at acceptance time is finding out
         too late.
    Conflicts are surfaced but do NOT block: a double-book on one occurrence
    is a coverage question for one date, not a reason to refuse a standing
    arrangement. `offer-check` shows them first.
    """
    oid = resolve_org_id(org_id, db)
    route = _get(db, route_id, oid)
    if route.status not in ("draft", "offered"):
        raise HTTPException(status_code=409,
                            detail=f"This route is {route.status}, so it can't be offered.")

    blocker = routes_service.validate_offerable(db, route)
    if blocker:
        raise HTTPException(status_code=409, detail=blocker)

    u = _cleaner_by_crew_id(db, body.cleaner_id, oid)
    if u is None:
        raise HTTPException(status_code=404,
                            detail="That crew ID isn't linked to anyone who can sign in.")
    missing = missing_requirements(db, u.id)
    if missing:
        raise HTTPException(status_code=403, detail={
            "message": f"{u.full_name or u.email} can't take work yet.",
            "missing": missing,
        })

    route.owner_cleaner_id = body.cleaner_id
    route.status = "offered"
    route.offered_at = _now()
    route.accepted_at = None
    route.updated_at = _now()
    db.commit(); db.refresh(route)
    return routes_service.route_dict(db, route, with_members=True)


@router.post("/{route_id}/end", dependencies=[Depends(require_role("admin", "manager"))])
def end_route(route_id: int, body: EndBody = EndBody(), db: Session = Depends(get_db),
              org_id: int = Depends(current_org_id)):
    """Stop a route generating. It stays for history.

    Visits already generated keep their owner and their agreed_rate — ending a
    route is a statement about the future, and no automated path here deletes
    or reprices a Job (R7). If a date needs to come off the calendar, that is a
    schedule edit somebody makes on purpose.
    """
    oid = resolve_org_id(org_id, db)
    route = _get(db, route_id, oid)
    if route.status == "ended":
        return routes_service.route_dict(db, route, with_members=True)
    route.status = "ended"
    route.ended_at = _now()
    route.updated_at = _now()
    db.commit(); db.refresh(route)
    return routes_service.route_dict(db, route, with_members=True)


@router.delete("/{route_id}", dependencies=[Depends(require_role("admin"))])
def delete_route(route_id: int, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id)):
    """Drafts only. A route that was ever offered is a record of something
    somebody was asked to do — that gets ended, not erased."""
    oid = resolve_org_id(org_id, db)
    route = _get(db, route_id, oid)
    if route.status != "draft":
        raise HTTPException(
            status_code=409,
            detail="Only a draft can be deleted. End the route instead — it stays for history.")
    db.query(RouteMember).filter(RouteMember.route_id == route.id).delete(
        synchronize_session=False)
    db.delete(route)
    db.commit()
    return {"deleted": route_id}
