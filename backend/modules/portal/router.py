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
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from auth_jwt import SECRET_KEY, ALGORITHM
from config import app_base_url
from database.db import get_db
from database.models import Client, Job, Quote, Invoice
from ratelimit import rate_limit
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
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _read_token(token: str, expected_typ: str) -> Optional[str]:
    """Return the email a valid token of the expected type carries, else None."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None
    if payload.get("typ") != expected_typ:
        return None
    email = (payload.get("email") or "").strip().lower()
    return email or None


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
    """Exchange a valid magic-link token for a portal session token."""
    email = _read_token(body.token or "", "portal_magic")
    if not email:
        raise HTTPException(status_code=400, detail="This sign-in link is invalid or expired.")
    clients = _clients_for_email(db, email)
    if not clients:
        # The client was removed between link issue and click.
        raise HTTPException(status_code=400, detail="We couldn't find your account.")
    session = _make_token(email, "portal_session", timedelta(days=_SESSION_TTL_DAYS))
    name = clients[0].name or email
    return {"token": session, "email": email, "name": name}


# ── Read-only data, always scoped to the signed-in email ────────────────────

@router.get("/me")
def me(ctx=Depends(portal_ctx)):
    clients = ctx["clients"]
    name = clients[0].name if clients else ctx["email"]
    return {"email": ctx["email"], "name": name, "accounts": len(clients)}


def _visit_dict(j: Job) -> dict:
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
    upcoming = [_visit_dict(j) for j in upcoming_rows]
    past = [_visit_dict(j) for j in reversed(rows) if j.scheduled_date and j.scheduled_date < today]
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
    from modules.invoicing.router import _invoice_public_token
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
        # Deep-link to the existing public payment page.
        "pay_id": inv.id,
        "pay_token": _invoice_public_token(inv.id),
    } for inv in rows]}
