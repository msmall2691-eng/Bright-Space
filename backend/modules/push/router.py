"""
Web Push subscription management.

  GET    /api/push/vapid-public-key  → { enabled, publicKey }
  POST   /api/push/subscriptions     → register this device (idempotent on endpoint)
  DELETE /api/push/subscriptions     → drop this device's subscription
  POST   /api/push/test              → send a test push to the caller's devices
  GET    /api/push/preferences       → per-category opt-out map for this user
  PATCH  /api/push/preferences       → flip one or more categories

All routes require an authenticated staff user. Subscriptions are keyed by the
browser's push `endpoint`, so re-subscribing the same device just refreshes the
keys rather than creating duplicates.
"""
import logging
from datetime import datetime, timezone
from typing import Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import PushSubscription, User
from modules.auth.router import get_current_user, current_org_id
from services import push_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/push", tags=["push"])


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class SubscribeBody(BaseModel):
    endpoint: str
    keys: PushKeys


class UnsubscribeBody(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
def vapid_public_key(_user: User = Depends(get_current_user)):
    """The browser needs the VAPID public key to subscribe. `enabled` is false
    when the server has no keys configured — the UI hides the toggle then."""
    return {"enabled": push_service.push_enabled(), "publicKey": push_service.get_public_key()}


@router.get("/status")
def push_status(
    user: User = Depends(get_current_user),
    org_id: int = Depends(current_org_id),
    db: Session = Depends(get_db),
):
    """Diagnostics for the Settings panel (owner report: 'I'm not getting
    notifications at all' — the answer should be readable in the app, not a
    debugging session). Says whether the server is configured and how many
    devices are registered for this user and org-wide."""
    mine = db.query(PushSubscription).filter(PushSubscription.user_id == user.id).count()
    org = db.query(PushSubscription).filter(PushSubscription.org_id == org_id).count()
    return {
        "server_configured": push_service.push_enabled(),
        "my_devices": mine,
        "org_devices": org,
    }


@router.post("/subscriptions")
def subscribe(
    body: SubscribeBody,
    request: Request,
    user: User = Depends(get_current_user),
    org_id: int = Depends(current_org_id),
    db: Session = Depends(get_db),
):
    """Register (or refresh) this device's push subscription."""
    existing = (
        db.query(PushSubscription)
        .filter(PushSubscription.endpoint == body.endpoint)
        .first()
    )
    ua = (request.headers.get("user-agent") or "")[:255]
    if existing:
        existing.user_id = user.id
        existing.org_id = org_id
        existing.p256dh = body.keys.p256dh
        existing.auth = body.keys.auth
        existing.user_agent = ua
        existing.last_used_at = datetime.now(timezone.utc)
    else:
        db.add(PushSubscription(
            org_id=org_id,
            user_id=user.id,
            endpoint=body.endpoint,
            p256dh=body.keys.p256dh,
            auth=body.keys.auth,
            user_agent=ua,
        ))
    db.commit()
    return {"ok": True}


@router.delete("/subscriptions")
def unsubscribe(
    body: UnsubscribeBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Drop this device's subscription (user turned notifications off)."""
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == body.endpoint
    ).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


@router.post("/test")
def send_test(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fire a test notification to the CALLER's own device(s) only — was
    notify_staff (org-wide broadcast) until a cleaner self-test button was
    added to the crew app; every other cleaner and office user in the org
    would have felt a stray "Push notifications are on" ping each time
    anyone tapped their own test button. notify_user scopes it to exactly
    the person who asked, matching the module docstring's original intent
    ("send a test push to the caller's devices")."""
    sent = push_service.notify_user(
        user.id,
        "BrightBase",
        "Push notifications are on 🎉",
        url="/messages",
    )
    return {"ok": True, "sent": sent, "enabled": push_service.push_enabled()}


@router.get("/preferences")
def get_preferences(user: User = Depends(get_current_user)):
    """This user's full category map — every category valid for their role,
    explicit true/false, so the frontend never has to guess a default. Missing
    key or `true` = on; only an explicit `false` is off (opt-out semantics,
    migration 094). Per-user, not per-org — no org_id needed."""
    cats = push_service.categories_for_role(user.role)
    prefs = user.notification_prefs or {}
    return {c: (prefs.get(c) is not False) for c in cats}


@router.patch("/preferences")
def patch_preferences(
    body: Dict[str, bool] = Body(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Merge a partial {category: bool} patch into the caller's stored prefs.
    Only categories valid for the caller's own role may be set — an office
    role can't touch crew-only categories and vice versa."""
    cats = push_service.categories_for_role(user.role)
    unknown = [c for c in body if c not in cats]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown or wrong-role notification categor{'y' if len(unknown) == 1 else 'ies'}: {', '.join(sorted(unknown))}",
        )
    prefs = dict(user.notification_prefs or {})
    prefs.update(body)
    user.notification_prefs = prefs
    db.commit()
    return {c: (prefs.get(c) is not False) for c in cats}
