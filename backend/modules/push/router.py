"""
Web Push subscription management.

  GET    /api/push/vapid-public-key  → { enabled, publicKey }
  POST   /api/push/subscriptions     → register this device (idempotent on endpoint)
  DELETE /api/push/subscriptions     → drop this device's subscription
  POST   /api/push/test              → send a test push to the caller's devices

All routes require an authenticated staff user. Subscriptions are keyed by the
browser's push `endpoint`, so re-subscribing the same device just refreshes the
keys rather than creating duplicates.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Request
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
    org_id: int = Depends(current_org_id),
    db: Session = Depends(get_db),
):
    """Fire a test notification to the caller's org so they can confirm the
    round-trip works after enabling it in Settings."""
    sent = push_service.notify_staff(
        db,
        "BrightBase",
        "Push notifications are on 🎉",
        url="/messages",
        tag="test",
        org_id=org_id,
    )
    return {"ok": True, "sent": sent, "enabled": push_service.push_enabled()}
