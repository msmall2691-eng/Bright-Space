"""Applying to join the bench, and the office deciding (migration 102).

The last phase of the marketplace pivot, and last on purpose: an apply form is
worthless until there's a file for an accepted sub to fill in (098), a way to
pay them (099), and work to offer them (100, 101).

TWO AUDIENCES, ONE MODULE, AND THE SPLIT IS THE POINT.

`POST /api/apply` is PUBLIC — listed in auth._PUBLIC_PREFIXES, reachable by
anyone with the link. It can do exactly one thing: write a row to
`sub_applications` with status "new". It cannot create a login, cannot set a
status, cannot read anything back beyond "we got it", and cannot see whether an
email is already known (that would make this an account-enumeration oracle).

Everything else here is admin/manager. Approval — the step that mints a crew
account and emails an invite — is a person clicking a button, never a
consequence of somebody filling in a form.

WHAT THE PUBLIC ENDPOINT DEFENDS AGAINST:
  * volume — rate limited per IP, like every other public write here;
  * repeat submissions — a second application from the same email inside a day
    updates the first rather than stacking rows the office has to de-dupe by
    hand. Somebody who fills the form in twice is not two applicants;
  * oversized input — every field is length-capped before it reaches the DB, so
    a 10MB "experience" can't be used to fill the disk;
  * being told anything. The response is the same shape whether the row was
    created or updated, and it never says which.

It does NOT accept an SSN or a TIN. There is no column for one and no field on
the form; `ein` identifies a business and is optional. A sole proprietor should
leave it blank rather than typing their social security number into it, and the
form says exactly that.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import SubApplication, User
from modules.auth.router import (
    current_org_id, require_role, resolve_org_id, send_staff_invite,
)
from ratelimit import limiter
from utils.contacts import normalize_phone

router = APIRouter()

STATUSES = ("new", "reviewing", "approved", "declined")

# A second application from the same person inside this window updates the
# first. Longer than the intake dedup (5 minutes) because this isn't a
# double-click — it's somebody who applied on Tuesday, heard nothing, and
# applied again on Wednesday. Both are the same applicant.
_DEDUP_HOURS = 24

# Length caps, applied before anything reaches the database. Generous enough
# for a real answer, small enough that the field can't be used as storage.
_CAPS = {"name": 200, "email": 255, "phone": 32, "business_name": 200,
         "ein": 32, "towns": 2000, "experience": 4000, "message": 4000,
         "source": 64}


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clip(value: Optional[str], field: str) -> Optional[str]:
    """Trim, cap, and turn empty into NULL.

    Truncates rather than refusing: somebody who wrote three thousand words
    about their cleaning philosophy has still applied, and bouncing the form
    over it would lose a candidate to a validation error they can't see the
    reason for.
    """
    if value is None:
        return None
    text = " ".join(str(value).split()) if field in ("name", "email", "phone") \
        else str(value).strip()
    text = text[:_CAPS[field]]
    return text or None


class ApplyBody(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    business_name: Optional[str] = None
    ein: Optional[str] = None
    towns: Optional[str] = None
    experience: Optional[str] = None
    message: Optional[str] = None
    has_insurance: Optional[bool] = None
    has_transport: Optional[bool] = None
    weekends: Optional[bool] = None
    source: Optional[str] = None
    # Honeypot: a field no human sees and no real browser fills. Bots fill
    # every input they find. A hit is accepted with the normal response and
    # silently dropped — telling a scraper it was caught only teaches it.
    website: Optional[str] = None


@router.post("/apply", status_code=201)
@limiter.limit("10/hour")
def apply(request: Request, body: ApplyBody, db: Session = Depends(get_db)):
    """Public. Records an application; creates nothing else.

    Always answers the same way. It will not say whether this email already
    applied, already works here, or was declined last spring — an endpoint that
    distinguishes those is an account-enumeration oracle wearing a form.
    """
    accepted = {"ok": True,
                "message": "Thanks — we've got it. We'll be in touch."}

    if _clip(body.website, "name"):
        return accepted            # honeypot: looks accepted, stores nothing

    name = _clip(body.name, "name")
    email = (_clip(body.email, "email") or "").lower() or None
    if not name or not email or "@" not in email:
        raise HTTPException(status_code=422,
                            detail="Please give us your name and an email we can reach you at.")

    # Deliberately org 1: this form is TMCC's own, served from its own domain,
    # and there is no tenant in the URL to read. A multi-tenant apply page
    # would need a per-org token in the path — see the portal's per-user feed
    # tokens for the shape — and would be a different endpoint.
    oid = 1
    since = _now() - timedelta(hours=_DEDUP_HOURS)
    existing = (db.query(SubApplication)
                .filter(SubApplication.email == email,
                        SubApplication.created_at >= since,
                        or_(SubApplication.org_id == oid, SubApplication.org_id.is_(None)))
                .order_by(SubApplication.id.desc())
                .first())

    fields = dict(
        name=name,
        phone=normalize_phone(_clip(body.phone, "phone")),
        business_name=_clip(body.business_name, "business_name"),
        ein=_clip(body.ein, "ein"),
        towns=_clip(body.towns, "towns"),
        experience=_clip(body.experience, "experience"),
        message=_clip(body.message, "message"),
        has_insurance=body.has_insurance,
        has_transport=body.has_transport,
        weekends=body.weekends,
        source=_clip(body.source, "source"),
    )

    if existing is not None and existing.status in ("new", "reviewing"):
        # Same applicant, same week. Update rather than stack a second row the
        # office would have to de-dupe by hand. A DECIDED application is left
        # alone: overwriting a decline with a fresh "new" would quietly undo
        # somebody's decision.
        for k, v in fields.items():
            if v is not None:
                setattr(existing, k, v)
        existing.updated_at = _now()
        db.commit()
        return accepted

    row = SubApplication(org_id=oid, email=email, status="new",
                         created_at=_now(), updated_at=_now(), **fields)
    db.add(row)
    db.commit()

    try:
        from services.push_service import notify_staff
        notify_staff(db, "Someone applied to join the bench",
                     f"{name}" + (f" · {fields['towns']}" if fields["towns"] else ""),
                     url="/users?tab=applications", org_id=oid, category="ops")
    except Exception:
        pass                       # a push outage must not lose an application
    return accepted


# ── The office side ─────────────────────────────────────────────────────────

def _row(a: SubApplication) -> dict:
    return {
        "id": a.id, "name": a.name, "email": a.email, "phone": a.phone,
        "business_name": a.business_name, "ein": a.ein,
        "towns": a.towns, "experience": a.experience, "message": a.message,
        "has_insurance": a.has_insurance, "has_transport": a.has_transport,
        "weekends": a.weekends, "source": a.source,
        "status": a.status, "notes": a.notes,
        "user_id": a.user_id,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "decided_at": a.decided_at.isoformat() if a.decided_at else None,
    }


def _get(db: Session, app_id: int, oid: int) -> SubApplication:
    row = (db.query(SubApplication)
           .filter(SubApplication.id == app_id,
                   or_(SubApplication.org_id == oid, SubApplication.org_id.is_(None)))
           .first())
    if row is None:
        raise HTTPException(status_code=404, detail="Application not found.")
    return row


@router.get("/sub-applications", dependencies=[Depends(require_role("admin", "manager"))])
def list_applications(status: Optional[str] = None, db: Session = Depends(get_db),
                      org_id: int = Depends(current_org_id)):
    """Everyone who's asked, newest first, with the counts the tab needs.

    One request draws the screen (brightbase-economy) — the counts come from
    the same rows rather than a second query per status.
    """
    oid = resolve_org_id(org_id, db)
    q = db.query(SubApplication).filter(
        or_(SubApplication.org_id == oid, SubApplication.org_id.is_(None)))
    rows = q.order_by(SubApplication.created_at.desc(), SubApplication.id.desc()).all()
    counts = {s: sum(1 for r in rows if r.status == s) for s in STATUSES}
    if status in STATUSES:
        rows = [r for r in rows if r.status == status]
    return {"applications": [_row(r) for r in rows], "counts": counts}


class ReviewBody(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None


@router.patch("/sub-applications/{app_id}",
              dependencies=[Depends(require_role("admin", "manager"))])
def review_application(app_id: int, body: ReviewBody, db: Session = Depends(get_db),
                       org_id: int = Depends(current_org_id),
                       current_user: User = Depends(require_role("admin", "manager"))):
    """Move an application along, or write a note on it.

    `approved` is NOT settable here — that status is a side effect of the
    approve endpoint, which also creates the account. Letting it be set
    directly would produce applications marked approved with nobody to show
    for it.
    """
    oid = resolve_org_id(org_id, db)
    row = _get(db, app_id, oid)
    if body.status is not None:
        if body.status == "approved":
            raise HTTPException(
                status_code=422,
                detail="Use Approve — it creates their crew account and sends the invite.")
        if body.status not in STATUSES:
            raise HTTPException(status_code=422, detail=f"Unknown status: {body.status}")
        row.status = body.status
        row.decided_at = _now() if body.status == "declined" else None
        row.decided_by = current_user.id if body.status == "declined" else None
    if body.notes is not None:
        row.notes = body.notes or None
    row.updated_at = _now()
    db.commit()
    return _row(row)


@router.post("/sub-applications/{app_id}/approve",
             dependencies=[Depends(require_role("admin"))])
def approve_application(app_id: int, db: Session = Depends(get_db),
                        org_id: int = Depends(current_org_id),
                        current_user: User = Depends(require_role("admin"))):
    """Turn an application into a crew account and email the invite.

    This is the only path from "somebody filled in a form" to "somebody can
    sign in", and it is admin-only and manual by design.

    Approving does NOT clear them to work. It gives them a login, and the login
    lands them on My File with a W-9, a certificate of insurance and an
    agreement to provide (098). `can_take_jobs` stays false until those are on
    record and accepted — so an approved application is an invitation to get
    vetted, not a shortcut past it.

    The invite email is the SAME sender the crew-add screen uses
    (`send_staff_invite`), so wording and the 7-day expiry can't drift apart.
    """
    oid = resolve_org_id(org_id, db)
    row = _get(db, app_id, oid)
    if row.status == "approved" and row.user_id:
        raise HTTPException(status_code=409,
                            detail="This one's already approved — they have an account.")

    existing = (db.query(User)
                .filter(User.email == row.email,
                        or_(User.org_id == oid, User.org_id.is_(None)))
                .first())
    if existing is not None:
        # Somebody already works here under this address. Link the application
        # to them rather than minting a second account for the same person.
        row.status, row.user_id = "approved", existing.id
        row.decided_at, row.decided_by = _now(), current_user.id
        row.updated_at = _now()
        db.commit()
        return {**_row(row), "created_account": False,
                "message": f"{existing.full_name or existing.email} already has an account — linked."}

    user = User(email=row.email, password_hash=None,
                full_name=row.name or row.email,
                role="cleaner", status="invited", active=True, org_id=oid,
                auth_provider="password")
    db.add(user)
    db.flush()                     # assigns the id the crew ID derives from
    # Same minting rule as the crew-add screen: 'bb{id}' is unique by
    # construction and can't collide with a legacy numeric ID.
    user.cleaner_id = f"bb{user.id}"

    row.status, row.user_id = "approved", user.id
    row.decided_at, row.decided_by = _now(), current_user.id
    row.updated_at = _now()
    db.commit(); db.refresh(user)

    try:
        send_staff_invite(user)
    except Exception:
        # The account exists either way. An invite that didn't send is a resend
        # from the Staff screen, not a reason to roll back an approval.
        pass
    return {**_row(row), "created_account": True, "cleaner_id": user.cleaner_id,
            "message": f"Invited {user.email}. They'll set a password, then their file."}
