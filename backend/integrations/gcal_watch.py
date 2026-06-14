"""Audit #4 Upgrade 2 (B): Google Calendar push channels (events.watch).

Real-time half of the sync. Google calls our public notification endpoint
whenever a watched calendar changes; we authenticate the callback by the channel
token, then run an INCREMENTAL sync (the syncToken from Upgrade 2A) for just that
calendar — so an edit on your phone reflects in BrightBase in seconds instead of
on the next poll.

Channel registry is stored per calendar in AppSetting (gcal_watch:{cal_id}),
mirroring the syncToken storage. Channels expire (~a week), so a scheduler tick
renews them before expiry. Gated by GCAL_WATCH_ENABLED — it only works when the
server has a public base URL, so it's OFF by default.
"""
import os
import json
import hmac
import secrets
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from database.models import AppSetting

log = logging.getLogger(__name__)

NOTIFICATION_PATH = "/api/integrations/gcal/notifications"
# Google caps calendar channels at ~1 week; renew a day before expiry.
WATCH_TTL_SECONDS = int(os.getenv("GCAL_WATCH_TTL_SECONDS", str(7 * 24 * 3600)))
RENEW_WITHIN_SECONDS = int(os.getenv("GCAL_WATCH_RENEW_WITHIN_SECONDS", str(24 * 3600)))
_PREFIX = "gcal_watch:"


def _key(cal_id: str) -> str:
    return f"{_PREFIX}{cal_id}"


def _get(db: Session, cal_id: str):
    row = db.query(AppSetting).filter(AppSetting.key == _key(cal_id)).first()
    if not row or not row.value:
        return None
    try:
        return json.loads(row.value)
    except (ValueError, TypeError):
        return None


def _put(db: Session, cal_id: str, data) -> None:
    key = _key(cal_id)
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if data is None:
        if row:
            db.delete(row)
            db.flush()
        return
    payload = json.dumps(data)
    if row:
        row.value = payload
    else:
        db.add(AppSetting(key=key, value=payload))


def _all_watches(db: Session):
    """[(cal_id, data)] for every registered channel."""
    out = []
    for row in db.query(AppSetting).filter(AppSetting.key.like(f"{_PREFIX}%")).all():
        try:
            data = json.loads(row.value) if row.value else None
        except (ValueError, TypeError):
            data = None
        if data:
            out.append((row.key[len(_PREFIX):], data))
    return out


def find_calendar_for_channel(db: Session, channel_id: str, token: str):
    """The cal_id whose stored channel matches id + token (constant-time compare),
    or None. This is the authentication for the public webhook."""
    if not channel_id or not token:
        return None
    for cal_id, data in _all_watches(db):
        if data.get("channel_id") == channel_id and hmac.compare_digest(
            str(data.get("token", "")), str(token)
        ):
            return cal_id
    return None


def register_watches(db: Session, base_url: str, calendar_ids=None) -> dict:
    """(Re)register a push channel for each configured calendar. Stops the prior
    channel first so we don't leak channels. Returns a per-calendar status dict."""
    from integrations import google_calendar as gc
    from integrations.gcal_sync import resolve_calendar_ids

    if not base_url:
        return {"ok": False, "error": "no base_url (set APP_BASE_URL) — can't register a public webhook"}
    address = base_url.rstrip("/") + NOTIFICATION_PATH
    if not address.startswith("https://"):
        return {"ok": False, "error": f"webhook address must be https, got {address}"}

    calendar_ids = calendar_ids or resolve_calendar_ids()
    results = {}
    for cal_id in calendar_ids:
        prior = _get(db, cal_id)
        if prior and prior.get("channel_id") and prior.get("resource_id"):
            gc.stop_watch(prior["channel_id"], prior["resource_id"])
        token = secrets.token_urlsafe(24)
        res = gc.start_watch(cal_id, address, token, WATCH_TTL_SECONDS)
        if res:
            _put(db, cal_id, {**res, "token": token, "address": address})
            results[cal_id] = {"ok": True, "expiration_ms": res.get("expiration_ms")}
        else:
            results[cal_id] = {"ok": False}
    db.commit()
    return {"ok": any(v.get("ok") for v in results.values()), "calendars": results}


def handle_notification(db: Session, headers: dict) -> dict:
    """Process a Google push: authenticate by channel token, then run an
    incremental sync for the matched calendar. ``headers`` keys lowercased."""
    state = (headers.get("x-goog-resource-state") or "").lower()
    channel_id = headers.get("x-goog-channel-id")
    token = headers.get("x-goog-channel-token")

    cal_id = find_calendar_for_channel(db, channel_id, token)
    if cal_id is None:
        log.warning("[gcal-watch] notification with unknown/invalid channel %s", channel_id)
        return {"ok": False, "reason": "unknown_or_bad_token"}

    # The first message after registration is a 'sync' handshake — just ack it.
    if state == "sync":
        return {"ok": True, "synced": False, "reason": "handshake", "calendar": cal_id}

    from integrations.gcal_sync import sync_calendar
    sync_calendar(db, calendar_ids=[cal_id])
    return {"ok": True, "synced": True, "calendar": cal_id}


def renew_expiring(db: Session, base_url: str) -> dict:
    """Re-register channels that expire within RENEW_WITHIN_SECONDS."""
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    due = []
    for cal_id, data in _all_watches(db):
        exp = data.get("expiration_ms")
        if exp is None or exp - now_ms <= RENEW_WITHIN_SECONDS * 1000:
            due.append(cal_id)
    if not due:
        return {"renewed": 0}
    res = register_watches(db, base_url, calendar_ids=due)
    return {"renewed": len(due), "result": res}
