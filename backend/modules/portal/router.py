"""
Customer self-service portal — passwordless, email-scoped, read-mostly.

Everything a customer can see is bound to the email they sign in with. There
are NO customer passwords: a customer requests a one-time magic link, we email
it to the address on file, and clicking it exchanges the short-lived magic token
for a longer-lived portal *session* token. Every data endpoint resolves that
session's email to the set of Client rows sharing that email and filters
strictly to those — the request never carries a client_id we trust.

Security model / why this is safe:
  * Portal tokens are JWTs signed with the same secret as staff tokens but carry
    a distinct ``typ`` claim ("portal_magic" / "portal_session") and NO
    ``user_id``. So a portal token can never satisfy get_current_user (it looks
    up a staff User by user_id → none → 401), and a staff token can never
    satisfy the portal (verify requires the portal ``typ``). Mutual isolation.
  * request-link is enumeration-safe: it returns the same 200 whether or not the
    email matches a customer, and it's rate-limited.
  * The whole /api/portal/ prefix is in auth.py's public allowlist (customers
    have no staff API key); the per-endpoint portal dependency here is the real
    gate on the data routes.
"""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from auth_jwt import SECRET_KEY, ALGORITHM
from config import app_base_url
from database.db import get_db
from database.models import Client, Job, Quote, Invoice, UsedPortalMagicLink
from ratelimit import rate_limit
from services import crew_intro
from utils.dates import business_today

logger = logging.getLogger(__name__)
router = APIRouter()

_MAGIC_TTL_MIN = 30          # a sign-in link is good for 30 minutes
_SESSION_TTL_DAYS = 14       # a signed-in session lasts 14 days
_portal_bearer = HTTPBearer(auto_error=False)


# ── Tokens ──────────────────────────────────────────────────────────────────

def _make_token(email: str, typ: str, ttl: timedelta) -> str:
    payload = {
        "email": email.strip().lower(),
        "typ": typ,
        "exp": datetime.now(timezone.utc) + ttl,
    }
    # A magic link must be single-use (BB-SEC-21). The jti is the id the
    # redemption ledger records; a session token deliberately gets none, because
    # a session is *meant* to be reused for its whole 14-day life.
    if typ == "portal_magic":
        payload["jti"] = secrets.token_urlsafe(16)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _decode(token: str, expected_typ: str) -> Optional[dict]:
    """Return the full payload of a valid token of the expected type, else None."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None
    if payload.get("typ") != expected_typ:
        return None
    return payload


def _read_token(token: str, expected_typ: str) -> Optional[str]:
    """Return the email a valid token of the expected type carries, else None."""
    payload = _decode(token, expected_typ)
    if not payload:
        return None
    email = (payload.get("email") or "").strip().lower()
    return email or None


def _consume_magic_link(db: Session, payload: dict, token: str) -> bool:
    """Record this magic link as used, returning True only on its FIRST redemption.

    Single-use is enforced by the primary key of used_portal_magic_links, not by
    a read-then-write: the INSERT is the lock, so two clicks racing on the same
    link (a real double-tap, or a replayed leaked link hitting at once) both try
    to write the same id and exactly one wins. The loser trips the unique
    violation and gets False — refused, not a second session.

    The id is the token's `jti`; a link minted before jti shipped has none, so
    it falls back to a hash of the token itself. Either way one opaque id per
    link, so even in-flight legacy links are single-use through the deploy.
    """
    key = payload.get("jti") or hashlib.sha256((token or "").encode()).hexdigest()
    exp = payload.get("exp")
    expires_at = (datetime.fromtimestamp(exp, tz=timezone.utc)
                  if isinstance(exp, (int, float)) else None)
    row = UsedPortalMagicLink(jti=key,
                              used_at=datetime.now(timezone.utc),
                              expires_at=expires_at)
    try:
        with db.begin_nested():          # SAVEPOINT: a collision unwinds only this
            db.add(row)
        db.commit()
        return True
    except IntegrityError:
        # Already redeemed — the link was used once and is now spent.
        return False


def _prune_used_links(db: Session) -> None:
    """Best-effort delete of ledger rows whose token could no longer be valid.

    A spent link past its own expiry can't be replayed anyway, so its row is
    dead weight. Pruned opportunistically here rather than on a background tick
    (scheduling-invariants R1) — sign-ins are low-volume, so this stays cheap.
    Never allowed to break a sign-in: any failure is swallowed."""
    try:
        db.query(UsedPortalMagicLink).filter(
            UsedPortalMagicLink.expires_at.isnot(None),
            UsedPortalMagicLink.expires_at < datetime.now(timezone.utc),
        ).delete(synchronize_session=False)
        db.commit()
    except Exception:
        db.rollback()


# ── Email → the customer's own records ──────────────────────────────────────

def _clients_for_email(db: Session, email: str):
    """Every Client row whose email matches (case-insensitive). A customer may
    exist as more than one client row (e.g. multiple properties); the portal
    shows all of them because they're all the same person by email."""
    email = (email or "").strip().lower()
    if not email:
        return []
    return (db.query(Client)
            .filter(func.lower(Client.email) == email)
            .all())


def portal_ctx(
    db: Session = Depends(get_db),
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_portal_bearer),
):
    """Auth dependency for portal data endpoints. Resolves the session token to
    (email, [client_ids]). 401 if the token is missing/invalid/not a portal
    session. NEVER trusts a client id from the request body/query."""
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Sign in to view your portal.")
    email = _read_token(creds.credentials, "portal_session")
    if not email:
        raise HTTPException(status_code=401, detail="Your session expired — sign in again.")
    clients = _clients_for_email(db, email)
    return {"email": email, "clients": clients, "client_ids": [c.id for c in clients]}


# ── Sign-in: request a magic link, then verify it ───────────────────────────

class LinkRequest(BaseModel):
    email: str


@router.post("/request-link", dependencies=[Depends(rate_limit(5, 900, "portal-link"))])
def request_link(body: LinkRequest, db: Session = Depends(get_db)):
    """Email a one-time sign-in link to the address IF it belongs to a customer.
    Always returns the same 200 so it can't be used to probe which emails exist."""
    email = (body.email or "").strip().lower()
    ok_response = {"ok": True,
                   "message": "If that email is on file, we just sent you a sign-in link."}
    if not email or "@" not in email:
        return ok_response
    clients = _clients_for_email(db, email)
    if not clients:
        return ok_response  # same response — no enumeration

    token = _make_token(email, "portal_magic", timedelta(minutes=_MAGIC_TTL_MIN))
    link = f"{app_base_url().rstrip('/')}/portal/verify?token={token}"
    name = (clients[0].name or "there").split()[0]
    try:
        from integrations.email import send_email
        send_email(
            to=email,
            subject="Your sign-in link",
            html_body=(
                f"<p>Hi {name},</p>"
                f"<p>Here's your secure link to view and manage your cleanings. "
                f"It expires in {_MAGIC_TTL_MIN} minutes and can only be used once.</p>"
                f"<p><a href=\"{link}\" style=\"display:inline-block;padding:10px 18px;"
                f"background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;"
                f"font-weight:600\">Sign in to your portal</a></p>"
                f"<p style=\"color:#666;font-size:12px\">If you didn't request this, "
                f"you can ignore this email.</p>"
            ),
            text_body=f"Hi {name}, sign in to your portal (expires in "
                      f"{_MAGIC_TTL_MIN} min): {link}",
        )
    except Exception:
        # Never leak whether email is configured/failed to the caller.
        logger.exception("portal magic-link email failed for a customer")
    return ok_response


class VerifyRequest(BaseModel):
    token: str


@router.post("/verify", dependencies=[Depends(rate_limit(20, 900, "portal-verify"))])
def verify(body: VerifyRequest, db: Session = Depends(get_db)):
    """Exchange a valid, unused magic-link token for a portal session token.

    The exchange is SINGLE-USE (BB-SEC-21): the link is spent the first time it
    is redeemed, so a leaked or replayed link cannot mint a second session."""
    payload = _decode(body.token or "", "portal_magic")
    email = (payload.get("email") or "").strip().lower() if payload else ""
    if not email:
        raise HTTPException(status_code=400, detail="This sign-in link is invalid or expired.")
    clients = _clients_for_email(db, email)
    if not clients:
        # The client was removed between link issue and click.
        raise HTTPException(status_code=400, detail="We couldn't find your account.")
    # Spend the link. First redemption wins; a replay (or a second click) loses
    # the race on the primary key and is refused rather than handed a session.
    if not _consume_magic_link(db, payload, body.token or ""):
        raise HTTPException(
            status_code=400,
            detail="This sign-in link has already been used. Request a new one.")
    _prune_used_links(db)
    session = _make_token(email, "portal_session", timedelta(days=_SESSION_TTL_DAYS))
    name = clients[0].name or email
    return {"token": session, "email": email, "name": name}


# ── Read-only data, always scoped to the signed-in email ────────────────────

@router.get("/me")
def me(ctx=Depends(portal_ctx)):
    clients = ctx["clients"]
    name = clients[0].name if clients else ctx["email"]
    return {"email": ctx["email"], "name": name, "accounts": len(clients)}


def _visit_dict(j: Job, crew: Optional[list] = None) -> dict:
    return {
        "id": j.id,
        "title": j.title,
        "status": j.status,
        "date": str(j.scheduled_date) if j.scheduled_date else None,
        "start_time": str(j.start_time)[:5] if j.start_time else None,
        "end_time": str(j.end_time)[:5] if j.end_time else None,
        "address": j.address,
        "confirmed": j.customer_confirmed_at is not None,
        "reschedule_pending": j.reschedule_requested_at is not None,
        # The confirm/reschedule page is the existing audited public flow.
        "manage_token": j.public_token,
        # Who is (or was) coming — empty until somebody has actually won the
        # job; filled for upcoming AND past visits (BB-CUST-03, see `visits`
        # below). Photo bytes ride the public job token, not this payload.
        "crew": crew or [],
    }


@router.get("/visits")
def visits(ctx=Depends(portal_ctx), db: Session = Depends(get_db)):
    """The customer's visits — upcoming first, then recent past (last 90 days).
    Upcoming visits get a confirm/reschedule token so the customer can always
    manage them from the portal, even if no reminder has gone out yet."""
    from modules.scheduling.router import _ensure_job_public_token
    ids = ctx["client_ids"]
    if not ids:
        return {"upcoming": [], "past": []}
    today = business_today()
    since = today - timedelta(days=90)
    rows = (db.query(Job)
            .filter(Job.client_id.in_(ids),
                    Job.status.notin_(["cancelled"]),
                    Job.scheduled_date >= since)
            .order_by(Job.scheduled_date.asc()).all())
    upcoming_rows = [j for j in rows if j.scheduled_date and j.scheduled_date >= today]
    made = False
    for j in upcoming_rows:
        if not j.public_token:
            _ensure_job_public_token(j)
            made = True
    if made:
        db.commit()
    # One batched lookup for the WHOLE list — upcoming and past — rather than
    # one per row (brightbase-economy). Past visits now carry the crew too
    # (BB-CUST-03): the customer can see who cleaned last time. It is the same
    # safe disclosure crew_intro already makes for an upcoming visit — a first
    # name and last initial, and whether a photo exists — never a phone, an
    # email, or the stable crew id, so a finished job says "Amanda S. came"
    # and nothing a stranger could act on.
    # First non-NULL org across the batch: a legacy row with no org must not
    # drop the filter for everyone else in the list.
    batch_org = next((j.org_id for j in rows if j.org_id is not None), None)
    crew_by_job = crew_intro.for_jobs(db, rows, org_id=batch_org)
    upcoming = [_visit_dict(j, crew_by_job.get(j.id)) for j in upcoming_rows]
    past = [_visit_dict(j, crew_by_job.get(j.id))
            for j in reversed(rows) if j.scheduled_date and j.scheduled_date < today]
    return {"upcoming": upcoming, "past": past}


@router.get("/quotes")
def quotes(ctx=Depends(portal_ctx), db: Session = Depends(get_db)):
    ids = ctx["client_ids"]
    if not ids:
        return {"quotes": []}
    rows = (db.query(Quote)
            .filter(Quote.client_id.in_(ids),
                    Quote.status.notin_(["archived"]),
                    Quote.archived_at.is_(None))
            .order_by(Quote.created_at.desc()).limit(50).all())
    return {"quotes": [{
        "id": q.id,
        "number": q.quote_number,
        "title": q.title,
        "total": float(q.total or 0),
        "status": q.status,
        "valid_until": str(q.valid_until) if q.valid_until else None,
        "created_at": q.created_at.isoformat() if q.created_at else None,
        # Deep-link to the existing public quote page (view / accept).
        "view_token": q.public_token,
    } for q in rows]}


@router.get("/invoices")
def invoices(ctx=Depends(portal_ctx), db: Session = Depends(get_db)):
    ids = ctx["client_ids"]
    if not ids:
        return {"invoices": []}
    rows = (db.query(Invoice)
            .filter(Invoice.client_id.in_(ids))
            .order_by(Invoice.created_at.desc()).limit(50).all())
    return {"invoices": [{
        "id": inv.id,
        "number": inv.invoice_number,
        "total": float(inv.total or 0),
        "status": inv.status,
        "due_date": str(inv.due_date) if inv.due_date else None,
        "paid": inv.status == "paid",
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
        # NO PAY TOKEN. This used to mint one per invoice on every request —
        # a permanent bearer credential handed to the customer's browser for a
        # payment page that never worked and no longer exists. There is no
        # customer payment flow in this app (see modules/invoicing/router.py's
        # `process_payment`), so a credential for one was a live capability
        # with nothing behind it but a way in.
    } for inv in rows]}
