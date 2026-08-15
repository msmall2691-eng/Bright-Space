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

# Fixed notification categories, one per event family a user might want to
# quiet — see modules/push/router.py's GET/PATCH /api/push/preferences and
# the User.notification_prefs column (migration 094). Keep this list short;
# it's deliberately not one-category-per-call-site (all crew-generated staff
# alerts — claims, declines, time-off requests, availability conflicts, house
# notes, crew chat — bundle into "crew").
OFFICE_ROLES = ("admin", "manager", "viewer", "member")
CREW_ROLES = ("cleaner",)
OFFICE_NOTIFICATION_CATEGORIES: tuple[str, ...] = ("requests", "messages", "quotes", "crew")
CREW_NOTIFICATION_CATEGORIES: tuple[str, ...] = ("job_assignments", "office_messages", "time_off", "digest")


def categories_for_role(role: Optional[str]) -> tuple[str, ...]:
    """Which notification categories a user's role can see/set. Office and
    crew are disjoint sets — an office role can't touch crew-only categories
    and vice versa. Any other role (e.g. client) gets none."""
    if role in OFFICE_ROLES:
        return OFFICE_NOTIFICATION_CATEGORIES
    if role in CREW_ROLES:
        return CREW_NOTIFICATION_CATEGORIES
    return ()


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


def _category_enabled(prefs: Optional[dict], category: Optional[str]) -> bool:
    """Opt-OUT gate: a category is ON unless the user's notification_prefs
    explicitly sets it to `false`. `category=None` (uncategorized — e.g. the
    Settings "send test" button) always sends, ignoring prefs entirely."""
    if category is None:
        return True
    if not prefs:
        return True
    if category not in prefs:
        return True
    return prefs[category] is not False


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


def notify_user(
    user_id: int,
    title: str,
    body: str,
    *,
    url: str = "/",
    tag: Optional[str] = None,
    category: Optional[str] = None,
) -> int:
    """Send to ONE user's devices (crew morning digest etc.). Same contract
    as notify_staff: own short-lived session, best-effort, prunes dead
    endpoints, returns successful-send count, no-op when push is off.

    `category` gates the whole call against that user's notification_prefs
    (opt-out: missing/None prefs or a missing/true key = send). One extra
    indexed PK lookup, no new tick — see brightbase-economy."""
    if not push_enabled():
        return 0
    try:
        from database.db import SessionLocal
        from database.models import PushSubscription, User
    except Exception:
        return 0
    session = SessionLocal()
    try:
        prefs = session.query(User.notification_prefs).filter(
            User.id == user_id).scalar()
        if not _category_enabled(prefs, category):
            return 0
        subs = session.query(PushSubscription).filter(
            PushSubscription.user_id == user_id).all()
        if not subs:
            return 0
        payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
        sent, dead = 0, []
        for s in subs:
            status = _send_one({"endpoint": s.endpoint,
                                "keys": {"p256dh": s.p256dh, "auth": s.auth}}, payload)
            if status == 200:
                sent += 1
            elif status in (404, 410):
                dead.append(s.id)
        if dead:
            session.query(PushSubscription).filter(
                PushSubscription.id.in_(dead)).delete(synchronize_session=False)
            session.commit()
        return sent
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("[push] notify_user failed: %s", e)
        return 0
    finally:
        session.close()


def notify_staff(
    db: Optional[Session],
    title: str,
    body: str,
    *,
    url: str = "/",
    tag: Optional[str] = None,
    org_id: Optional[int] = None,
    category: Optional[str] = None,
) -> int:
    """Fan a notification out to every staff subscription (optionally scoped to
    one org). Returns the number of successful sends.

    Best-effort and transaction-safe: it always uses its OWN short-lived DB
    session (the `db` arg is ignored, kept only so call sites read naturally),
    so reading subscriptions, updating last_used_at, and pruning dead endpoints
    never touch — or commit — the caller's request transaction. Swallows all
    errors and is a no-op when push isn't configured.

    `category` (None = always send, e.g. the Settings "send test" button)
    joins each subscription to its owning user's notification_prefs in the
    same query and skips subscriptions whose owner opted that category off —
    one query, no per-row lookups (brightbase-economy)."""
    if not push_enabled():
        return 0
    try:
        from database.db import SessionLocal
        from database.models import PushSubscription, User
    except Exception:
        return 0

    session = SessionLocal()
    try:
        q = session.query(PushSubscription, User.notification_prefs).join(
            User, PushSubscription.user_id == User.id)
        if org_id is not None:
            q = q.filter(PushSubscription.org_id == org_id)
        rows = q.all()
        if not rows:
            return 0
        subs = [s for s, prefs in rows if _category_enabled(prefs, category)]
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
