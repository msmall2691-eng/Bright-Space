"""Real-time Gmail push (users.watch → Cloud Pub/Sub → our webhook).

Mirrors integrations.gcal_watch, but Gmail delivers through Google Cloud
Pub/Sub rather than HTTP push channels: Gmail publishes a tiny notification
({emailAddress, historyId}) to a Pub/Sub TOPIC on every mailbox change, and a
Pub/Sub PUSH SUBSCRIPTION forwards it to our webhook
(POST /api/integrations/gmail/push?token=…). We then run the same incremental
sync (run_account_inbox_sync) the poller uses.

SCAFFOLD — inert until infrastructure is provisioned. It no-ops unless
``GMAIL_PUBSUB_TOPIC`` is set AND the gmail_live_sync toggle is on, so merging
it changes nothing. Bringing it up is a one-time GCP setup, documented in
docs/gmail-realtime-push.md:
  1. Create a Pub/Sub topic; grant Publisher to
     gmail-api-push@system.gserviceaccount.com.
  2. Create a PUSH subscription to
     https://<host>/api/integrations/gmail/push?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>.
  3. Set GMAIL_PUBSUB_TOPIC and GMAIL_PUBSUB_VERIFICATION_TOKEN, enable
     gmail_live_sync in Settings.

Watch registry (expiration per account) is stored in AppSetting under
``gmail_watch:{account_id}`` — same approach gcal_watch uses for channels — so
no schema change is needed here.
"""
import base64
import hmac
import json
import logging
import os

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

# Gmail watches expire in ≤7 days; renew a day ahead. (Env-overridable, matching
# the gcal_watch knobs.)
WATCH_TTL_SECONDS = 7 * 24 * 3600
RENEW_WITHIN_SECONDS = int(os.getenv("GMAIL_WATCH_RENEW_WITHIN_SECONDS", str(24 * 3600)))
_PREFIX = "gmail_watch:"


def _topic() -> str:
    return (os.getenv("GMAIL_PUBSUB_TOPIC") or "").strip()


def _verification_token() -> str:
    return (os.getenv("GMAIL_PUBSUB_VERIFICATION_TOKEN") or "").strip()


def is_configured() -> bool:
    """True when a Pub/Sub topic is set — the "can we even register a watch?"
    signal, distinct from the per-user gmail_live_sync toggle."""
    return bool(_topic())


def live_sync_enabled(db: Session) -> bool:
    """Whether real-time Gmail push is turned on (Settings → Automation),
    AND a topic is configured. OFF by default; env GMAIL_LIVE_SYNC overrides the
    DB toggle."""
    if not is_configured():
        return False
    env = os.getenv("GMAIL_LIVE_SYNC")
    if env is not None:
        return env.strip().lower() in {"1", "true", "yes", "on"}
    try:
        from modules.settings.router import get_setting, _coerce_bool
        return _coerce_bool(get_setting(db, "gmail_live_sync"), False)
    except Exception:  # pragma: no cover - settings unavailable
        return False


# ── watch registry (AppSetting) ────────────────────────────────────────────

def _key(account_id) -> str:
    return f"{_PREFIX}{account_id}"


def _get(db: Session, account_id):
    from modules.settings.router import get_setting
    raw = get_setting(db, _key(account_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _put(db: Session, account_id, data) -> None:
    from modules.settings.router import set_setting
    set_setting(db, _key(account_id), json.dumps(data))


def _all_watches(db: Session):
    """[(account_id, data)] for every registered watch."""
    from database.models import AppSetting
    out = []
    for row in db.query(AppSetting).filter(AppSetting.key.like(f"{_PREFIX}%")).all():
        try:
            out.append((row.key[len(_PREFIX):], json.loads(row.value)))
        except Exception:
            continue
    return out


# ── register / stop / renew ────────────────────────────────────────────────

def _sync_enabled_accounts(db: Session):
    from database.models import UserGoogleAccount
    return (db.query(UserGoogleAccount)
            .filter(UserGoogleAccount.gmail_sync_enabled.is_(True),
                    UserGoogleAccount.status == "connected")
            .all())


def register_watch(db: Session, account) -> dict:
    """(Re)register a Gmail push watch for one account. Seeds the incremental
    cursor from the watch's historyId if the account has none yet. Best-effort —
    returns a status dict, never raises into the caller."""
    if not is_configured():
        return {"ok": False, "error": "no GMAIL_PUBSUB_TOPIC configured"}
    try:
        from integrations.google_accounts import account_credentials
        from integrations import gmail_api
        creds = account_credentials(db, account)
        res = gmail_api.start_watch(creds, _topic(), label_ids=["INBOX"])
        _put(db, account.id, {
            "expiration_ms": res.get("expiration_ms"),
            "email": account.email,
        })
        # Seed the cursor so the first push has a startHistoryId to read from.
        if res.get("history_id") and not getattr(account, "gmail_history_id", None):
            account.gmail_history_id = res["history_id"]
            db.commit()
        return {"ok": True, "expiration_ms": res.get("expiration_ms")}
    except Exception as e:
        log.warning("[gmail-watch] register failed for %s: %s",
                    getattr(account, "email", "?"), e)
        return {"ok": False, "error": str(e)}


def register_all(db: Session) -> dict:
    """Register a watch for every gmail-sync-enabled connected account."""
    if not live_sync_enabled(db):
        return {"ok": False, "error": "gmail_live_sync disabled or unconfigured"}
    results = {acc.email: register_watch(db, acc) for acc in _sync_enabled_accounts(db)}
    return {"ok": True, "accounts": results}


def stop_watch(db: Session, account) -> dict:
    try:
        from integrations.google_accounts import account_credentials
        from integrations import gmail_api
        gmail_api.stop_watch(account_credentials(db, account))
    except Exception as e:  # pragma: no cover - stop is best-effort
        log.info("[gmail-watch] stop failed for %s: %s", getattr(account, "email", "?"), e)
    from modules.settings.router import set_setting
    set_setting(db, _key(account.id), "")
    return {"ok": True}


def renew_expiring(db: Session) -> dict:
    """Re-register watches that expire within RENEW_WITHIN_SECONDS. Called from
    the scheduler tick. No-ops when live sync is off."""
    if not live_sync_enabled(db):
        return {"ok": False, "error": "disabled", "renewed": 0}
    try:
        from utils.dates import now_ms
        cutoff = now_ms() + RENEW_WITHIN_SECONDS * 1000
    except Exception:
        # utils.dates has no now_ms — fall back so this never breaks the tick.
        import time
        cutoff = int(time.time() * 1000) + RENEW_WITHIN_SECONDS * 1000
    by_id = {str(a.id): a for a in _sync_enabled_accounts(db)}
    renewed = 0
    for account_id, data in _all_watches(db):
        exp = data.get("expiration_ms")
        if exp is not None and exp > cutoff:
            continue  # still fresh
        acc = by_id.get(str(account_id))
        if acc and register_watch(db, acc).get("ok"):
            renewed += 1
    return {"ok": True, "renewed": renewed}


# ── inbound push handling ──────────────────────────────────────────────────

def _authenticated(token: str) -> bool:
    """Constant-time compare of the URL token against the configured secret.
    Pub/Sub can also send an OIDC JWT (Authorization: Bearer) — verifying that
    is a stronger option, but the shared URL token mirrors gcal_watch and needs
    no extra Google client. Fails closed when no token is configured."""
    want = _verification_token()
    if not want:
        return False
    return bool(token) and hmac.compare_digest(token, want)


def handle_push(db: Session, token: str, body: dict) -> dict:
    """Process a Pub/Sub push. Authenticates by the URL token, decodes the
    Gmail notification ({emailAddress, historyId}), finds the matching connected
    account, and runs an incremental sync. Always returns a dict (the webhook
    always 200s so Pub/Sub doesn't retry-storm)."""
    if not _authenticated(token):
        return {"ok": False, "error": "unauthenticated"}
    try:
        data_b64 = ((body or {}).get("message") or {}).get("data") or ""
        payload = json.loads(base64.b64decode(data_b64).decode("utf-8")) if data_b64 else {}
    except Exception as e:
        log.warning("[gmail-watch] undecodable push payload: %s", e)
        return {"ok": False, "error": "bad_payload"}

    email = (payload.get("emailAddress") or "").lower()
    if not email:
        return {"ok": False, "error": "no_email"}

    from database.models import UserGoogleAccount
    account = (db.query(UserGoogleAccount)
               .filter(UserGoogleAccount.email == email,
                       UserGoogleAccount.gmail_sync_enabled.is_(True))
               .first())
    if not account:
        # Not an error — could be an account we don't sync; ack so Pub/Sub stops.
        return {"ok": True, "skipped": "no_matching_account"}

    from modules.gmail.router import run_account_inbox_sync
    result = run_account_inbox_sync(db, account)
    return {"ok": True, "email": email, "summary": result.get("summary")}
