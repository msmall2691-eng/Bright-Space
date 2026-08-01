"""
Web Push (VAPID) delivery for BrightBase staff notifications.

Design goals mirror the existing owner-email path in the quoting router:
best-effort, never raises into the caller, and a no-op until configured. If
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` aren't set (or `pywebpush` isn't
installed), every function here quietly does nothing — the app runs exactly as
before.

Wiring:
  - The frontend fetches the public key from GET /api/push/vapid-public-key and
    subscribes the browser, POSTing the subscription to /api/push/subscriptions.
  - Event sites (new request, inbound message, quote viewed) call
    `notify_staff(db, title, body, url=..., tag=...)`.
  - A send that comes back 404/410 means the browser dropped the subscription;
    we delete that row so the table self-heals.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _vapid_keys() -> Optional[tuple[str, str, str]]:
    """(public, private, subject) or None when push isn't configured."""
    pub = os.getenv("VAPID_PUBLIC_KEY")
    priv = os.getenv("VAPID_PRIVATE_KEY")
    if not pub or not priv:
        return None
    subject = os.getenv("VAPID_SUBJECT") or "mailto:ops@brightbase.app"
    return pub, priv, subject


def push_enabled() -> bool:
    """True when both VAPID keys are present. Cheap — safe to call per event."""
    return _vapid_keys() is not None


def get_public_key() -> Optional[str]:
    keys = _vapid_keys()
    return keys[0] if keys else None


def _send_one(subscription: dict, payload: str, ttl: int = 43200) -> int:
    """Send to a single subscription. Returns the HTTP status (0 on library
    error). Raises nothing — callers inspect the code to decide on pruning."""
    from pywebpush import webpush, WebPushException  # local import: optional dep

    _, priv, subject = _vapid_keys()
    try:
        webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=priv,
            vapid_claims={"sub": subject},
            ttl=ttl,
        )
        return 200
    except WebPushException as e:
        # 404/410 → the endpoint is gone; anything else is a transient/config
        # problem we log but don't prune on.
        status = getattr(getattr(e, "response", None), "status_code", 0) or 0
        if status not in (404, 410):
            logger.warning("[push] send failed (%s): %s", status, e)
        return status
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("[push] unexpected send error: %s", e)
        return 0


def notify_staff(
    db: Optional[Session],
    title: str,
    body: str,
    *,
    url: str = "/",
    tag: Optional[str] = None,
    org_id: Optional[int] = None,
) -> int:
    """Fan a notification out to every staff subscription (optionally scoped to
    one org). Returns the number of successful sends.

    Best-effort and transaction-safe: it always uses its OWN short-lived DB
    session (the `db` arg is ignored, kept only so call sites read naturally),
    so reading subscriptions, updating last_used_at, and pruning dead endpoints
    never touch — or commit — the caller's request transaction. Swallows all
    errors and is a no-op when push isn't configured."""
    if not push_enabled():
        return 0
    try:
        from database.db import SessionLocal
        from database.models import PushSubscription
    except Exception:
        return 0

    session = SessionLocal()
    try:
        q = session.query(PushSubscription)
        if org_id is not None:
            q = q.filter(PushSubscription.org_id == org_id)
        subs = q.all()
        if not subs:
            return 0

        payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
        sent, dead = 0, []
        for s in subs:
            sub_info = {
                "endpoint": s.endpoint,
                "keys": {"p256dh": s.p256dh, "auth": s.auth},
            }
            status = _send_one(sub_info, payload)
            if status == 200:
                sent += 1
                s.last_used_at = datetime.now(timezone.utc)
            elif status in (404, 410):
                dead.append(s.id)

        if dead:
            session.query(PushSubscription).filter(
                PushSubscription.id.in_(dead)
            ).delete(synchronize_session=False)
        session.commit()
        return sent
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("[push] notify_staff failed: %s", e)
        try:
            session.rollback()
        except Exception:
            pass
        return 0
    finally:
        session.close()
