"""
App Settings Router - email/IMAP credentials, integrations, etc.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import Response
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database.db import get_db
from database.models import AppSetting
from modules.auth.router import require_role, current_org_id, resolve_org_id
from config import app_base_url
import base64
import hashlib
import re
import imaplib
import smtplib
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

SENSITIVE_KEYS = {"smtp_pass", "imap_pass"}
# Any setting whose key matches this is a secret (OAuth tokens, SSO nonces, API
# keys, passwords) and must never be returned in full. get_all_settings used to
# return google_token (a full Google OAuth refresh token) and the sso_* nonces
# in cleartext to any caller.
_SECRET_KEY_RE = re.compile(r'(pass|secret|token|credential|api_key|sso_|client_secret)', re.IGNORECASE)
EMAIL_SETTING_KEYS = [
    "smtp_user", "smtp_pass", "smtp_host", "smtp_port",
    "imap_host", "imap_port",
    "from_email", "from_name",
    "email_auto_enrich",
]


def get_setting(db: Session, key: str) -> Optional[str]:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else None


def set_setting(db: Session, key: str, value: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


class EmailConfig(BaseModel):
    smtp_user: Optional[str] = None
    smtp_pass: Optional[str] = None
    smtp_host: Optional[str] = "smtp.gmail.com"
    smtp_port: Optional[str] = "587"
    imap_host: Optional[str] = "imap.gmail.com"
    imap_port: Optional[str] = "993"
    from_email: Optional[str] = None
    from_name: Optional[str] = None
    email_auto_enrich: Optional[str] = "true"


@router.get("/email", dependencies=[Depends(require_role("admin"))])
def get_email_settings(db: Session = Depends(get_db)):
    import os
    result = {}
    env_map = {
        "smtp_user": "SMTP_USER", "smtp_pass": "SMTP_PASS",
        "smtp_host": "SMTP_HOST", "smtp_port": "SMTP_PORT",
        "imap_host": "IMAP_HOST", "imap_port": "IMAP_PORT",
        "from_email": "FROM_EMAIL", "from_name": "FROM_NAME",
    }
    for key in EMAIL_SETTING_KEYS:
        db_val = get_setting(db, key)
        env_val = os.getenv(env_map.get(key, ""), "")
        val = db_val or env_val
        if key in SENSITIVE_KEYS and val:
            result[key] = "****" + val[-4:] if len(val) > 4 else "****"
        else:
            result[key] = val or ""
        result[f"{key}_source"] = "database" if db_val else ("env" if env_val else "none")

    db_user = get_setting(db, "smtp_user")
    db_pass = get_setting(db, "smtp_pass")
    env_user = os.getenv("SMTP_USER", "")
    env_pass = os.getenv("SMTP_PASS", "")
    result["has_credentials"] = bool((db_user or env_user) and (db_pass or env_pass))
    result["credentials_source"] = "database" if (db_user and db_pass) else ("env" if (env_user and env_pass) else "none")

    # Auto-sync health for the shared inbox (written each tick by the
    # scheduler). Lets the UI show "last synced Xm ago / ✓ ok / ⚠ auth_failed"
    # so an expired App Password isn't invisible.
    result["last_sync"] = {
        "at": get_setting(db, "gmail_inbox_last_sync_at") or "",
        "status": get_setting(db, "gmail_inbox_last_sync_status") or "",
        "error": get_setting(db, "gmail_inbox_last_sync_error") or "",
        "threaded": int(get_setting(db, "gmail_inbox_last_sync_threaded") or 0),
    }
    return result


@router.post("/email", dependencies=[Depends(require_role("admin"))])
def save_email_settings(config: EmailConfig, db: Session = Depends(get_db)):
    data = config.model_dump(exclude_none=True)
    for key, value in data.items():
        if key in SENSITIVE_KEYS and value and value.startswith("****"):
            continue
        set_setting(db, key, str(value))
    db.commit()
    return {"status": "saved"}


@router.post("/email/test", dependencies=[Depends(require_role("admin"))])
def test_email_connection(db: Session = Depends(get_db)):
    user = get_setting(db, "smtp_user")
    passwd = get_setting(db, "smtp_pass")
    imap_host = get_setting(db, "imap_host") or "imap.gmail.com"
    imap_port = int(get_setting(db, "imap_port") or "993")

    if not user or not passwd:
        import os
        user = user or os.getenv("SMTP_USER", "")
        passwd = passwd or os.getenv("SMTP_PASS", "")

    if not user or not passwd:
        raise HTTPException(400, "No email credentials configured. Enter your Gmail address and App Password.")

    results = {"imap": None, "smtp": None, "email_count": 0}

    try:
        # Explicit timeout — the SMTP check below already had one; this bare
        # IMAP4_SSL call didn't, so a hung IMAP host here could wedge the
        # worker indefinitely (T-20 Part A).
        mail = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=10)
        mail.login(user, passwd)
        mail.select("INBOX", readonly=True)
        _, data = mail.search(None, "ALL")
        ids = data[0].split()
        results["imap"] = "connected"
        results["email_count"] = len(ids)
        mail.logout()
    except Exception as e:
        results["imap"] = f"failed: {str(e)}"

    try:
        smtp_host = get_setting(db, "smtp_host") or "smtp.gmail.com"
        smtp_port = int(get_setting(db, "smtp_port") or "587")
        with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
            server.starttls()
            server.login(user, passwd)
            results["smtp"] = "connected"
    except Exception as e:
        results["smtp"] = f"failed: {str(e)}"

    return results


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def get_all_settings(db: Session = Depends(get_db)):
    rows = db.query(AppSetting).all()
    result = {}
    for row in rows:
        if row.key in SENSITIVE_KEYS or _SECRET_KEY_RE.search(row.key or ""):
            v = row.value or ""
            result[row.key] = ("****" + v[-4:]) if len(v) > 4 else "****"
        else:
            result[row.key] = row.value
    return result


class GeneralSettings(BaseModel):
    company_name: Optional[str] = None
    company_email: Optional[str] = None
    company_phone: Optional[str] = None
    timezone: Optional[str] = None
    currency: Optional[str] = None
    # Optional terms & conditions shown at the bottom of the public quote page.
    quote_terms: Optional[str] = None
    # Customer-facing service policies (one per line) shown on the quote email,
    # PDF, and public page — pickup/tidy, home access, 24h cancellation, etc.
    quote_policies: Optional[str] = None
    # Header band color for every customer-facing quote surface.
    brand_color: Optional[str] = None
    # Optional logo URL shown on the public quote page, email, and PDF.
    company_logo_url: Optional[str] = None
    # Default customer-facing "what's included" scope per service type. Used to
    # pre-fill a new quote's scope; the admin can still edit it per quote.
    service_scope_residential: Optional[str] = None
    service_scope_commercial: Optional[str] = None
    service_scope_str: Optional[str] = None


_GENERAL_KEYS = ("company_name", "company_email", "company_phone",
                 "timezone", "currency", "quote_terms", "quote_policies",
                 "brand_color", "company_logo_url",
                 "service_scope_residential", "service_scope_commercial",
                 "service_scope_str")


# Default customer-facing service policies. One per line so email/PDF/page can
# render a clean bulleted list. Editable in Settings → General → Service
# Policies; a blank setting falls back to these.
DEFAULT_QUOTE_POLICIES = (
    "Please pick up and put away personal items and clutter before your visit so "
    "we can clean and sanitize surfaces thoroughly.\n"
    "Please make sure the home is accessible on your scheduled day — a key, lockbox, "
    "door code, or someone home.\n"
    "Need to cancel or reschedule? Please give us at least 24 hours' notice; "
    "same-day cancellations may be subject to a fee.\n"
    "For everyone's safety, please secure pets during the visit.\n"
    "Please have running water, power, and heat/AC available so we can do our best work.\n"
    "Payment is due upon completion unless we've arranged otherwise."
)


def quote_policies_text(db: Session) -> str:
    """The configured service policies, or the sensible default when unset."""
    v = get_setting(db, "quote_policies")
    return v if (v is not None and v.strip()) else DEFAULT_QUOTE_POLICIES


@router.get("/general", dependencies=[Depends(require_role("admin", "manager"))])
def get_general_settings(db: Session = Depends(get_db)):
    return {k: get_setting(db, k) for k in _GENERAL_KEYS}


_HEX_COLOR_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _normalize_brand_color(value: str) -> str:
    """'1f2937' / '#1F2937' / '#abc' -> '#1f2937' form. Anything else is a
    400: a bad value would make colors.HexColor() raise inside PDF
    generation, and PDF generation precedes email delivery — quote sends
    would fail until the setting was fixed."""
    m = _HEX_COLOR_RE.match((value or "").strip())
    if not m:
        raise HTTPException(400, "Brand Color must be a hex color like #1f2937")
    hexpart = m.group(1).lower()
    if len(hexpart) == 3:
        hexpart = "".join(ch * 2 for ch in hexpart)
    return f"#{hexpart}"


@router.post("/general", dependencies=[Depends(require_role("admin"))])
def save_general_settings(config: GeneralSettings, db: Session = Depends(get_db)):
    """Persist company identity + quote terms. The Settings UI was already
    POSTing here — the endpoint just never existed, so 'Company Information'
    silently failed to save. These rows feed the public quote page and the
    quote email (settings first, env fallback)."""
    for key in _GENERAL_KEYS:
        value = getattr(config, key)
        if value is not None:
            if key == "brand_color" and value.strip():
                value = _normalize_brand_color(value)
            if key == "company_logo_url" and value.strip() and not value.strip().startswith(("http://", "https://")):
                raise HTTPException(400, "Company Logo URL must start with http:// or https://")
            set_setting(db, key, value.strip())
    db.commit()
    return {k: get_setting(db, k) for k in _GENERAL_KEYS}


# Logo upload. The logo is consumed by three unauthenticated surfaces — the
# quote email (<img src>), the PDF (fetched over HTTP), and the public quote
# page — so it must be servable WITHOUT a login. We store the bytes in
# app_settings (base64) and serve them from a stable public URL, then point
# company_logo_url at it. This avoids depending on external image hosting or an
# ephemeral filesystem (Railway wipes local disk on redeploy).
_LOGO_DATA_KEY = "company_logo_data"        # base64-encoded image bytes
_LOGO_MIME_KEY = "company_logo_mime"        # e.g. "image/png"
_MAX_LOGO_BYTES = 2 * 1024 * 1024           # 2 MB — plenty for a logo
_ALLOWED_LOGO_MIME = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}


@router.post("/general/logo", dependencies=[Depends(require_role("admin"))])
async def upload_company_logo(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Store an uploaded logo image and point company_logo_url at our served
    copy. Returns the new public logo URL (with a cache-busting version)."""
    content_type = (file.content_type or "").lower().split(";")[0].strip()
    if content_type not in _ALLOWED_LOGO_MIME:
        raise HTTPException(400, "Logo must be a PNG, JPG, GIF, WEBP, or SVG image")
    data = await file.read()
    if not data:
        raise HTTPException(400, "The uploaded file is empty")
    if len(data) > _MAX_LOGO_BYTES:
        raise HTTPException(400, "Logo is too large — please upload an image under 2 MB")

    set_setting(db, _LOGO_DATA_KEY, base64.b64encode(data).decode("ascii"))
    set_setting(db, _LOGO_MIME_KEY, content_type)
    # Cache-bust so email/PDF/page pick up a replacement immediately.
    version = hashlib.sha256(data).hexdigest()[:8]
    logo_url = f"{app_base_url().rstrip('/')}/api/settings/logo?v={version}"
    set_setting(db, "company_logo_url", logo_url)
    db.commit()
    return {"company_logo_url": logo_url}


@router.delete("/general/logo", dependencies=[Depends(require_role("admin"))])
def delete_company_logo(db: Session = Depends(get_db)):
    """Remove the stored logo and clear company_logo_url."""
    for key in (_LOGO_DATA_KEY, _LOGO_MIME_KEY, "company_logo_url"):
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        if row:
            row.value = None
    db.commit()
    return {"company_logo_url": None}


@router.get("/logo")
def serve_company_logo(db: Session = Depends(get_db)):
    """Serve the stored logo bytes. PUBLIC (no auth) — email clients, the PDF
    generator, and the public quote page all load it without a session."""
    data_b64 = get_setting(db, _LOGO_DATA_KEY)
    if not data_b64:
        raise HTTPException(404, "No logo set")
    mime = get_setting(db, _LOGO_MIME_KEY) or "image/png"
    try:
        raw = base64.b64decode(data_b64)
    except Exception:
        raise HTTPException(404, "No logo set")
    # Long cache; the URL carries a ?v= content hash so replacements bust it.
    return Response(content=raw, media_type=mime,
                    headers={"Cache-Control": "public, max-age=86400"})


class PropertyMediaConfig(BaseModel):
    property_photo_enabled: Optional[bool] = None
    google_maps_api_key: Optional[str] = None      # blank = leave unchanged
    property_enrichment_enabled: Optional[bool] = None
    rentcast_api_key: Optional[str] = None          # blank = leave unchanged


@router.get("/property-media", dependencies=[Depends(require_role("admin", "manager"))])
def get_property_media(db: Session = Depends(get_db)):
    """Property photo + data integration status. Never returns the raw keys —
    only whether each is configured."""
    return {
        "property_photo_enabled": (get_setting(db, "property_photo_enabled") or "").lower() == "true",
        "google_maps_key_set": bool(get_setting(db, "google_maps_api_key")),
        "property_enrichment_enabled": (get_setting(db, "property_enrichment_enabled") or "").lower() == "true",
        "rentcast_key_set": bool(get_setting(db, "rentcast_api_key")),
    }


@router.post("/property-media", dependencies=[Depends(require_role("admin"))])
def save_property_media(config: PropertyMediaConfig, db: Session = Depends(get_db)):
    """Save the Street View / property-data toggles and keys. A blank key field
    leaves the stored key unchanged (so the UI never has to round-trip secrets)."""
    if config.property_photo_enabled is not None:
        set_setting(db, "property_photo_enabled", "true" if config.property_photo_enabled else "false")
    if config.property_enrichment_enabled is not None:
        set_setting(db, "property_enrichment_enabled", "true" if config.property_enrichment_enabled else "false")
    if config.google_maps_api_key and config.google_maps_api_key.strip():
        set_setting(db, "google_maps_api_key", config.google_maps_api_key.strip())
    if config.rentcast_api_key and config.rentcast_api_key.strip():
        set_setting(db, "rentcast_api_key", config.rentcast_api_key.strip())
    db.commit()
    return get_property_media(db)


@router.get("/from-email")
def get_from_email(db: Session = Depends(get_db)):
    """Get the configured from_email for sending replies."""
    from_email = get_setting(db, "from_email")
    if not from_email:
        import os
        from_email = os.getenv("FROM_EMAIL", "")
    if not from_email:
        raise HTTPException(400, "from_email not configured")
    return {"from_email": from_email}


# ── Google Calendar embed (in-app "Google" schedule view) ──────────────────

class GcalEmbedConfig(BaseModel):
    embed_url: Optional[str] = None


def _build_gcal_embed_url(db: Session) -> Optional[str]:
    """An embeddable Google Calendar URL for the in-app Schedule. Prefers an
    explicit gcal_embed_url app-setting (paste the embed/public URL from Google
    Calendar settings — works for private calendars you've shared); otherwise
    builds one from EVERY configured calendar the two-way sync writes to —
    residential, commercial, AND STR turnovers — so the view matches the full
    synced schedule (Airbnb turnovers go to GCAL_STR_ID, see
    integrations/google_calendar.py:_calendar_id). Multiple src= params overlay
    all of them in the embed."""
    import os
    from urllib.parse import quote
    override = (get_setting(db, "gcal_embed_url") or "").strip()
    if override:
        return override
    ids = []
    for env_key in ("GCAL_RESIDENTIAL_ID", "GCAL_COMMERCIAL_ID", "GCAL_STR_ID"):
        cid = os.getenv(env_key, "").strip()
        if cid and cid != "primary" and cid not in ids:
            ids.append(cid)
    if not ids:
        return None
    tz = os.getenv("GCAL_TIMEZONE", "America/New_York")
    src = "".join(f"&src={quote(cid)}" for cid in ids)
    return f"https://calendar.google.com/calendar/embed?ctz={quote(tz)}&mode=WEEK{src}"


def _build_gcal_overlay_all(db: Session) -> Optional[str]:
    """Overlay EVERY known calendar in one embed: the work account's primary
    calendar plus each configured GCAL_* calendar. Unlike _build_gcal_embed_url,
    this ignores the single pasted override so the dedicated Calendar page always
    stacks all calendars.

    Primary calendar resolution prefers the explicit GCAL_PRIMARY_ID — that's
    the real calendar id. ``from_email`` is only a fallback because it may be a
    *sending alias* (the address you send mail as), not a calendar, so picking it
    first could overlay the wrong/empty primary even when GCAL_PRIMARY_ID was set
    specifically for this."""
    import os
    from urllib.parse import quote
    ids = []
    primary = (
        os.getenv("GCAL_PRIMARY_ID")
        or get_setting(db, "from_email")
        or "office@mainecleaningco.com"
    ).strip()
    if primary:
        ids.append(primary)
    for env_key in ("GCAL_RESIDENTIAL_ID", "GCAL_COMMERCIAL_ID", "GCAL_STR_ID"):
        cid = os.getenv(env_key, "").strip()
        if cid and cid != "primary" and cid not in ids:
            ids.append(cid)
    if not ids:
        return _build_gcal_embed_url(db)
    tz = os.getenv("GCAL_TIMEZONE", "America/New_York")
    src = "".join(f"&src={quote(cid)}" for cid in ids)
    return f"https://calendar.google.com/calendar/embed?ctz={quote(tz)}&mode=WEEK{src}"


@router.get("/gcal-status")
def gcal_status():
    """Live Google Calendar connection check — tells the operator whether the
    server's Google credentials actually work, and which calendars the token
    can see vs. which the app writes to. Replaces the old hardcoded
    '✓ Connected' badge that lied when no token was present."""
    from integrations.google_calendar import connection_status
    return connection_status()


@router.post("/gcal-watch/register", dependencies=[Depends(require_role("admin"))])
def gcal_watch_register(db: Session = Depends(get_db)):
    """Register (or refresh) Google Calendar push channels for the configured
    business calendars, so external edits notify BrightBase in real time. Needs a
    public https APP_BASE_URL."""
    from integrations.gcal_watch import register_watches
    from config import app_base_url
    return register_watches(db, app_base_url())


@router.get("/gmail-status")
def gmail_status(db: Session = Depends(get_db)):
    """Per-account Gmail connection health so Settings can surface
    connected / token-expired / reconnect — the Gmail mirror of gcal-status.

    Without this, a Gmail grant could silently expire and inbound email would
    just stop syncing with no signal to the operator."""
    from database.models import UserGoogleAccount
    accounts, any_ok = [], False
    for a in db.query(UserGoogleAccount).all():
        scopes = a.scopes or []
        if not (a.gmail_sync_enabled or any("gmail" in (s or "") for s in scopes)):
            continue
        needs_reconnect = a.status != "connected" or not a.refresh_token
        any_ok = any_ok or not needs_reconnect
        accounts.append({
            "email": a.email,
            "status": a.status,
            "gmail_sync_enabled": a.gmail_sync_enabled,
            "token_expiry": a.token_expiry.isoformat() if a.token_expiry else None,
            "last_sync_at": a.last_sync_at.isoformat() if a.last_sync_at else None,
            "last_sync_error": a.last_sync_error,
            "needs_reconnect": needs_reconnect,
        })
    return {"connected": any_ok, "accounts": accounts}


# ── Connecteam credentials + push-schedule ─────────────────────────────────
# Lets an operator paste their Connecteam API key + Company ID in Settings →
# Integrations (instead of hunting for the Railway env vars) and push the
# upcoming schedule to Connecteam as open shifts. The DB values take precedence
# over CONNECTEAM_API_KEY / CONNECTEAM_COMPANY_ID; env stays as a fallback so
# existing deploys keep working.

class ConnecteamConfig(BaseModel):
    api_key: Optional[str] = None
    # The DB key stays `connecteam_company_id` for backward compat with rows
    # already saved (and the CONNECTEAM_COMPANY_ID env var), but the value it
    # holds is really the *scheduler id* — that's what the Connecteam scheduler
    # API path needs. Accept both field names on the way in; the UI now uses
    # scheduler_id so re-labelled installs Just Work.
    company_id: Optional[str] = None
    scheduler_id: Optional[str] = None
    # The Time Clock whose punches drive payroll — separate from the scheduler.
    timeclock_id: Optional[str] = None


def _mask_key(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    return "••••" + v[-4:] if len(v) > 4 else "••••"


_SCHEDULERS_CACHE_KEY = "connecteam_schedulers_cache"


def _read_cached_schedulers(db: Session) -> list:
    """Read the last successfully-fetched scheduler list from AppSetting.
    Returns [] on empty / malformed cache so callers never get None.

    We persist the list on every successful /connecteam/test so that
    subsequent status calls can show the picker without hitting Connecteam
    again — the rate-limit hell Megan spent hours in on 2026-07-04 came
    from every page load / form open re-fetching the same list. Once cached,
    the picker survives 429s, deploys, cache-busts, browser reloads."""
    import json as _json
    raw = get_setting(db, _SCHEDULERS_CACHE_KEY) or ""
    if not raw:
        return []
    try:
        parsed = _json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def _cache_schedulers(db: Session, schedulers: list) -> None:
    """Overwrite the cached scheduler list. Called after a successful
    /connecteam/test only — a failed list_schedulers doesn't wipe a good cache."""
    import json as _json
    set_setting(db, _SCHEDULERS_CACHE_KEY, _json.dumps(schedulers or []))


_TIMECLOCKS_CACHE_KEY = "connecteam_timeclocks_cache"


def _read_cached_timeclocks(db: Session) -> list:
    """Last successfully-fetched time-clock list (same rate-limit-dodging
    rationale as the scheduler cache)."""
    import json as _json
    raw = get_setting(db, _TIMECLOCKS_CACHE_KEY) or ""
    if not raw:
        return []
    try:
        parsed = _json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def _cache_timeclocks(db: Session, timeclocks: list) -> None:
    import json as _json
    set_setting(db, _TIMECLOCKS_CACHE_KEY, _json.dumps(timeclocks or []))


@router.get("/connecteam-status", dependencies=[Depends(require_role("admin", "manager"))])
def connecteam_status(db: Session = Depends(get_db)):
    """Whether Connecteam is wired up + a masked hint of the saved key so the
    Settings card can show "connected as scheduler 12345, key •••abcd".

    Also returns the cached scheduler list (from the last successful
    /connecteam/test) so the picker survives page loads without re-fetching
    from Connecteam every time — dodges the rate-limit spiral."""
    import os
    db_key = get_setting(db, "connecteam_api_key") or ""
    db_cid = get_setting(db, "connecteam_company_id") or ""
    db_tc = get_setting(db, "connecteam_timeclock_id") or ""
    env_key = os.getenv("CONNECTEAM_API_KEY", "")
    env_cid = os.getenv("CONNECTEAM_COMPANY_ID", "")
    env_tc = os.getenv("CONNECTEAM_TIMECLOCK_ID", "")
    key = (db_key or env_key).strip()
    cid = (db_cid or env_cid).strip()
    tc = (db_tc or env_tc).strip()
    schedulers = _read_cached_schedulers(db)
    timeclocks = _read_cached_timeclocks(db)
    return {
        "configured": bool(key and cid),
        "has_key": bool(key),
        "has_company_id": bool(cid),          # legacy field the current UI reads
        "has_scheduler_id": bool(cid),        # semantic name for the new UI
        "api_key_masked": _mask_key(key),
        "company_id": cid,                    # legacy field
        "scheduler_id": cid,                  # semantic alias — same value
        "source": ("database" if (db_key or db_cid) else ("env" if (env_key or env_cid) else "none")),
        "schedulers": schedulers,
        "timeclock_id": tc,                   # payroll time clock ("" = auto-pick)
        "timeclocks": timeclocks,             # cached picker options
        "has_timeclock_id": bool(tc),
        # Flag the mismatch server-side so the UI can show a persistent warning
        # on the connected card (not just inside the Update-key form).
        "scheduler_id_valid": bool(cid) and (
            not schedulers  # no cache yet — can't judge, don't warn
            or any(str(s.get("id")) == cid for s in schedulers)
        ),
    }


@router.post("/connecteam", dependencies=[Depends(require_role("admin"))])
def save_connecteam_settings(config: ConnecteamConfig, db: Session = Depends(get_db)):
    """Save (or clear) the Connecteam credentials. A masked value ("••••abcd")
    from the status endpoint is ignored so re-saving the form without retyping
    the key doesn't overwrite it with the mask. `scheduler_id` and the legacy
    `company_id` both write the same underlying `connecteam_company_id` row —
    same value semantically, different name on the wire."""
    key_changed = False
    if config.api_key is not None:
        v = config.api_key.strip()
        if v and not v.startswith("••••"):
            set_setting(db, "connecteam_api_key", v)
            key_changed = True
        elif v == "":
            set_setting(db, "connecteam_api_key", "")
            key_changed = True
    # scheduler_id wins when both are supplied — it's the semantic name.
    sched = config.scheduler_id if config.scheduler_id is not None else config.company_id
    if sched is not None:
        set_setting(db, "connecteam_company_id", sched.strip())
    if config.timeclock_id is not None:
        set_setting(db, "connecteam_timeclock_id", config.timeclock_id.strip())
    # A key change points at a different account — the previous account's
    # cached scheduler list is meaningless now. Clear the cache so the next
    # /connecteam/test re-fetches against the new key. Scheduler-id-only
    # changes keep the cache (same account, just picking a different one).
    if key_changed:
        _cache_schedulers(db, [])
    db.commit()
    return connecteam_status(db)


@router.post("/connecteam/test", dependencies=[Depends(require_role("admin", "manager"))])
def test_connecteam(db: Session = Depends(get_db)):
    """Verify the saved credentials against Connecteam and return the list of
    schedulers on the account so the operator can pick the right Scheduler ID.

    Uses GET /me for the auth smoke test (Connecteam's recommended cheapest
    endpoint) and GET /scheduler/v1/schedulers for the picker. Both go through
    the same X-API-KEY header — if the key is wrong, /me 401s and we surface
    that before ever hitting the scheduler list."""
    from integrations.connecteam import (
        is_configured, ConnecteamAuthError, get_me, list_schedulers,
        list_time_clocks,
    )
    if not is_configured():
        raise HTTPException(400, "Connecteam isn't configured yet — save an API key and Scheduler ID first.")
    try:
        import asyncio
        me = asyncio.run(get_me())
        try:
            schedulers = asyncio.run(list_schedulers())
        except Exception as e:
            # Scheduler list is a nice-to-have — the key is valid if /me
            # returned. Don't fail the whole test on a scheduler-list hiccup.
            logger.warning(f"Connecteam list_schedulers failed after /me OK: {e}")
            schedulers = []
        try:
            timeclocks = asyncio.run(list_time_clocks())
        except Exception as e:
            logger.warning(f"Connecteam list_time_clocks failed after /me OK: {e}")
            timeclocks = []
        # Persist the lists so future page loads and the connected-card pickers
        # don't need to re-hit Connecteam (rate-limit-friendly). Only cache
        # non-empty results — an empty response (from a 429/scope failure)
        # would overwrite a previously-good cache.
        if schedulers:
            _cache_schedulers(db, schedulers)
        if timeclocks:
            _cache_timeclocks(db, timeclocks)
        if schedulers or timeclocks:
            db.commit()
        return {
            "ok": True,
            "account": me.get("data") or me,
            "schedulers": schedulers,
            "timeclocks": timeclocks,
        }
    except ConnecteamAuthError:
        # ConnecteamAuthError's message is a fixed literal we author in
        # integrations/connecteam.py (no exception-carried detail), so it's
        # safe to surface verbatim as guidance.
        raise HTTPException(401, "Connecteam rejected the API key. Rotate CONNECTEAM_API_KEY and try again.")
    except Exception as e:
        # Log the underlying error server-side, but return a generic message —
        # Connecteam's client errors can carry request URLs / internal detail
        # we don't want to bounce back to the browser (CodeQL: information
        # exposure through an exception).
        logger.warning(f"Connecteam test call failed: {e}")
        raise HTTPException(502, "Connecteam call failed — check server logs for the underlying error.")


# ─── Square (payroll export) ────────────────────────────────────────────────

class SquareConfig(BaseModel):
    access_token: Optional[str] = None
    location_id: Optional[str] = None
    environment: Optional[str] = None  # "production" | "sandbox"
    # Square wage "job" titles to tag timecards with, so hours land in the right
    # bucket the operator runs payroll from.
    job_residential: Optional[str] = None
    job_rental: Optional[str] = None
    job_weekend: Optional[str] = None


_SQUARE_JOB_DEFAULTS = {
    "square_job_residential": "Residential",
    "square_job_rental": "Rental",
    "square_job_weekend": "Rate Pay",
}


def _square_jobs(db: Session) -> dict:
    return {
        "residential": get_setting(db, "square_job_residential") or _SQUARE_JOB_DEFAULTS["square_job_residential"],
        "rental": get_setting(db, "square_job_rental") or _SQUARE_JOB_DEFAULTS["square_job_rental"],
        "weekend": get_setting(db, "square_job_weekend") or _SQUARE_JOB_DEFAULTS["square_job_weekend"],
    }


_SQUARE_JOB_TITLES_CACHE_KEY = "square_job_titles_cache"


def _read_cached_square_job_titles(db: Session) -> list:
    import json as _json
    raw = get_setting(db, _SQUARE_JOB_TITLES_CACHE_KEY) or ""
    try:
        parsed = _json.loads(raw) if raw else []
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


@router.get("/square-status", dependencies=[Depends(require_role("admin", "manager"))])
def square_status(db: Session = Depends(get_db)):
    """Whether Square is wired up + a masked token hint, for the Settings card.
    Also returns cached locations from the last successful /square/test so the
    location picker survives reloads without re-hitting Square."""
    import os
    tok = (get_setting(db, "square_access_token") or os.getenv("SQUARE_ACCESS_TOKEN", "")).strip()
    loc = (get_setting(db, "square_location_id") or os.getenv("SQUARE_LOCATION_ID", "")).strip()
    env = (get_setting(db, "square_environment") or os.getenv("SQUARE_ENVIRONMENT", "production")).strip() or "production"
    locations = _read_cached_square_locations(db)
    return {
        "configured": bool(tok and loc),
        "has_token": bool(tok),
        "location_id": loc,
        "environment": env,
        "token_masked": _mask_key(tok),
        "locations": locations,
        "jobs": _square_jobs(db),
        "job_titles": _read_cached_square_job_titles(db),
    }


_SQUARE_LOCATIONS_CACHE_KEY = "square_locations_cache"


def _read_cached_square_locations(db: Session) -> list:
    import json as _json
    raw = get_setting(db, _SQUARE_LOCATIONS_CACHE_KEY) or ""
    if not raw:
        return []
    try:
        parsed = _json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


@router.post("/square", dependencies=[Depends(require_role("admin"))])
def save_square_settings(config: SquareConfig, db: Session = Depends(get_db)):
    """Save (or clear) Square credentials. A masked token from the status
    endpoint is ignored so re-saving without retyping doesn't wipe the token."""
    if config.access_token is not None:
        v = config.access_token.strip()
        if v and not v.startswith("••••"):
            set_setting(db, "square_access_token", v)
        elif v == "":
            set_setting(db, "square_access_token", "")
    if config.location_id is not None:
        set_setting(db, "square_location_id", config.location_id.strip())
    if config.environment is not None and config.environment.strip() in ("production", "sandbox"):
        set_setting(db, "square_environment", config.environment.strip())
    for field, key in (("job_residential", "square_job_residential"),
                       ("job_rental", "square_job_rental"),
                       ("job_weekend", "square_job_weekend")):
        v = getattr(config, field)
        if v is not None:
            set_setting(db, key, v.strip())
    db.commit()
    return square_status(db)


@router.post("/square/test", dependencies=[Depends(require_role("admin", "manager"))])
def test_square(db: Session = Depends(get_db)):
    """Verify the Square token and return the account's locations (so the
    operator can pick the right Location ID) + a team-member count."""
    import asyncio, json as _json
    from integrations.square import has_token, verify, SquareAuthError
    if not has_token():
        raise HTTPException(400, "Add a Square access token first.")
    try:
        res = asyncio.run(verify())
        if res.get("locations"):
            set_setting(db, _SQUARE_LOCATIONS_CACHE_KEY, _json.dumps(res["locations"]))
        if res.get("job_titles"):
            set_setting(db, _SQUARE_JOB_TITLES_CACHE_KEY, _json.dumps(res["job_titles"]))
        if res.get("locations") or res.get("job_titles"):
            db.commit()
        return res
    except SquareAuthError:
        raise HTTPException(401, "Square rejected the access token. Rotate it and try again.")
    except Exception as e:
        logger.warning(f"Square test call failed: {e}")
        raise HTTPException(502, "Square call failed — check server logs for the underlying error.")


class PushOpenShiftsBody(BaseModel):
    # Inclusive date range for jobs to push (YYYY-MM-DD).
    start_date: Optional[str] = None
    end_date: Optional[str] = None


def _run_push_open_shifts(run_id: str, start, end) -> None:
    """The actual bulk-push sweep (T-20 Part B). Runs as a background task —
    NOT in the request's DB session, since that session is torn down once
    the response is sent. Owns its own SessionLocal for the run's full
    lifetime and updates the connecteam_push_runs row as it goes so
    GET .../push-open-shifts/{run_id} always has something fresh to report,
    regardless of which uvicorn worker serves the poll.
    """
    from datetime import datetime, timezone
    from database.db import SessionLocal
    from database.models import ConnecteamPushRun, Job
    from integrations.connecteam import (
        ConnecteamAuthError, build_shift_payload, create_shifts_sync,
    )
    from utils.integration_log import log_integration_event as _log

    db = SessionLocal()
    try:
        run = db.query(ConnecteamPushRun).filter(ConnecteamPushRun.id == run_id).first()
        if not run:
            logger.warning(f"push_open_shifts: run {run_id} vanished before it could start")
            return
        run.status = "running"
        db.commit()

        jobs = (
            db.query(Job)
            .filter(
                Job.scheduled_date >= start,
                Job.scheduled_date <= end,
                Job.status.notin_(["cancelled", "completed"]),
            )
            .order_by(Job.scheduled_date, Job.start_time)
            .all()
        )

        # Build the bulk payload in one pass so we only hit Connecteam ONCE. The
        # pre-Jul-4 loop did N sequential POSTs against Connecteam's per-shift
        # endpoint which throttled at HTTP 429 "Too many requests" once you had
        # more than a handful of jobs — Connecteam's scheduler API is bulk-first
        # (up to 500 shifts in a single array body), and using it that way is
        # the fix.
        #
        # sendable[i] is the shift payload we hand to Connecteam.
        # job_by_index[i] is the Job that produced it. After the bulk call
        # returns ids in submission order, we map back through job_by_index[i]
        # to write connecteam_shift_ids on the right Job row.
        pushed, skipped, errors = 0, 0, []
        sendable = []
        job_by_index = []
        for job in jobs:
            if job.connecteam_shift_ids:
                skipped += 1
                continue
            if not job.scheduled_date or not job.start_time or not job.end_time:
                skipped += 1
                continue
            sendable.append(build_shift_payload(
                start_datetime=f"{job.scheduled_date}T{str(job.start_time)[:5]}:00",
                end_datetime=f"{job.scheduled_date}T{str(job.end_time)[:5]}:00",
                title=job.title,
                address=job.address,
                notes=job.notes,
                open_shift=True,
                # DRAFT, not published. Bright Space pushes the schedule as a
                # draft so the office can review + adjust in Connecteam before
                # making shifts visible to cleaners. Publishing is a one-click
                # step on Connecteam's side.
                is_published=False,
            ))
            job_by_index.append(job)

        if sendable:
            try:
                ids = create_shifts_sync(sendable)
            except ConnecteamAuthError:
                # Auth failure means the API key is bad — every subsequent push will
                # fail identically. Surface it as the run's terminal error so the
                # operator gets one clear "rotate the key" signal.
                run.status = "error"
                run.error_message = "Connecteam rejected the API key. Rotate CONNECTEAM_API_KEY and try again."
                run.finished_at = datetime.now(timezone.utc)
                db.commit()
                return
            except Exception as e:
                # Whole bulk POST failed. Log full detail server-side + to the
                # admin integration_events audit trail; the response surfaces only
                # the exception class name plus (if it's an httpx.HTTPStatusError)
                # Connecteam's HTTP status code and a truncated response body.
                # Both are safe — CodeQL's exception-exposure concern was about
                # OUR internal detail (URLs, auth), not the vendor's error text.
                logger.warning(f"push_open_shifts: bulk create_shifts failed for {len(sendable)} jobs: {e}")
                entry_common = {"error": type(e).__name__}
                import httpx as _httpx
                if isinstance(e, _httpx.HTTPStatusError) and e.response is not None:
                    entry_common["status"] = e.response.status_code
                    entry_common["body"] = (e.response.text or "")[:300]
                # Attribute the failure to every job that was in the bulk batch,
                # so the frontend toast can say "rejected N pushes" and count is
                # accurate.
                for job in job_by_index:
                    errors.append({"job_id": job.id, **entry_common})
                    _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                         action="create_open", status="failed", detail=str(e), commit=False)
            else:
                # Success path. Connecteam returns ids in submission order; if the
                # count comes back short (rare — e.g. some validated out per-shift),
                # we conservatively write only the ids we got, in order, and mark
                # the remaining jobs as failed with "no shift id returned".
                for i, job in enumerate(job_by_index):
                    sid = ids[i] if i < len(ids) else ""
                    if sid:
                        job.connecteam_shift_ids = [sid]
                        job.dispatched = True
                        _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                             action="create_open", status="ok", external_id=sid, commit=False)
                        pushed += 1
                    else:
                        errors.append({"job_id": job.id, "error": "no shift id returned"})
                        _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                             action="create_open", status="failed",
                             detail="no shift id returned", commit=False)

        run.status = "done"
        run.considered = len(jobs)
        run.pushed = pushed
        run.skipped = skipped
        run.errors = errors
        run.finished_at = datetime.now(timezone.utc)
        try:
            db.commit()
        except Exception as e:
            logger.warning(f"push_open_shifts commit failed: {e}")
            db.rollback()
    except Exception as e:
        # Anything unexpected (DB hiccup, programming error) still needs to
        # flip the run to a terminal state — otherwise a poller spins on
        # "running" forever with no way to know it died.
        logger.exception(f"push_open_shifts: run {run_id} crashed: {e}")
        try:
            run = db.query(ConnecteamPushRun).filter(ConnecteamPushRun.id == run_id).first()
            if run:
                run.status = "error"
                run.error_message = f"{type(e).__name__}: {e}"
                run.finished_at = datetime.now(timezone.utc)
                db.commit()
        except Exception:
            db.rollback()
    finally:
        db.close()


@router.post("/connecteam/push-open-shifts", status_code=202,
             dependencies=[Depends(require_role("admin", "manager"))])
def push_open_shifts(body: PushOpenShiftsBody, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Kick off pushing the Bright Space schedule to Connecteam as OPEN shifts
    (unassigned) so cleaners can self-claim them.

    Runs asynchronously (T-20 Part B): this just validates the request,
    writes a connecteam_push_runs row, and schedules the actual bulk-create
    sweep as a background task, returning 202 + a run_id immediately. Poll
    GET .../push-open-shifts/{run_id} for progress/result. The bulk POST to
    Connecteam previously ran inline here and could block the request (and
    on a single-worker deploy, every other request) for minutes.

    - Skips cancelled / completed jobs and anything already dispatched
      (connecteam_shift_ids populated) so re-clicking is idempotent.
    - Records the returned shift id on Job.connecteam_shift_ids and logs an
      integration event, matching the auto-dispatch path.
    - Defaults to today → today + 14 days when no range is provided.
    """
    import uuid
    from datetime import date, timedelta
    from database.models import ConnecteamPushRun
    from integrations.connecteam import is_configured

    if not is_configured():
        raise HTTPException(400, "Connecteam isn't configured yet — save an API key and Scheduler ID first.")

    today = date.today()
    try:
        start = date.fromisoformat(body.start_date) if body.start_date else today
        end = date.fromisoformat(body.end_date) if body.end_date else today + timedelta(days=14)
    except ValueError:
        raise HTTPException(400, "start_date/end_date must be YYYY-MM-DD")
    if end < start:
        raise HTTPException(400, "end_date must be on or after start_date")

    run_id = uuid.uuid4().hex
    db.add(ConnecteamPushRun(id=run_id, status="queued", range_start=start, range_end=end))
    db.commit()

    background_tasks.add_task(_run_push_open_shifts, run_id, start, end)
    return {"run_id": run_id, "status": "queued", "range": {"start_date": str(start), "end_date": str(end)}}


@router.get("/connecteam/push-open-shifts/{run_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_push_open_shifts_status(run_id: str, db: Session = Depends(get_db)):
    """Poll the status of a push-open-shifts run started by the POST above."""
    from database.models import ConnecteamPushRun

    run = db.query(ConnecteamPushRun).filter(ConnecteamPushRun.id == run_id).first()
    if not run:
        raise HTTPException(404, "Push run not found")

    return {
        "run_id": run.id,
        "status": run.status,
        "ok": run.status == "done" and (not run.errors or (run.pushed or 0) > 0),
        "considered": run.considered or 0,
        "pushed": run.pushed or 0,
        "skipped": run.skipped or 0,
        "errors": run.errors or [],
        "error": run.error_message,
        "range": {
            "start_date": str(run.range_start) if run.range_start else None,
            "end_date": str(run.range_end) if run.range_end else None,
        },
    }


@router.get("/connecteam/job-match-preview", dependencies=[Depends(require_role("admin", "manager"))])
def connecteam_job_match_preview(db: Session = Depends(get_db),
                                 org_id: int = Depends(current_org_id)):
    """Dry-run: how this workspace's properties will LINK to Connecteam Jobs.

    Pushed shifts link to the Connecteam Job (from the account's Jobs list) whose
    name matches the property (then its client) — see connecteam.match_job_id.
    Fetches the SCHEDULER's live Jobs list (the same instance dispatch uses) and
    shows, per active property, which Job it resolves to, so the operator can
    confirm names line up and spot any that WON'T match (those fall back to a
    free-text shift). Read-only — creates/changes nothing, and deliberately does
    NOT seed the shared dispatch cache (this diagnostic must not perturb live
    pushes).
    """
    from integrations.connecteam import (
        is_configured, get_jobs_sync, build_jobs_index, match_job_id, _get_scheduler_id,
    )
    from database.models import Property, Client

    if not is_configured():
        return {"configured": False, "jobs": [], "properties": [], "matched": 0, "unmatched": 0}
    try:
        # Scheduler-scoped, matching the dispatch resolver — a separate Time
        # Clock instance can have a different Jobs set.
        jobs = get_jobs_sync(_get_scheduler_id()) or {}  # {jobId: {"name","code"}}
    except Exception as e:
        return {"configured": True, "error": str(e)[:200],
                "jobs": [], "properties": [], "matched": 0, "unmatched": 0}

    # Match against a LOCAL index (no global-cache mutation).
    idx = build_jobs_index(jobs)
    ct_jobs = sorted(
        ({"id": str(jid), "name": (meta or {}).get("name", ""), "code": (meta or {}).get("code", "")}
         for jid, meta in jobs.items()),
        key=lambda j: (j["name"] or "").lower(),
    )

    # Scope to the caller's workspace (+ legacy null-org rows), like the
    # properties API — RLS doesn't compensate when the session tenant is unset.
    oid = resolve_org_id(org_id, db)
    def _scoped(q, model):
        return q.filter(or_(model.org_id == oid, model.org_id.is_(None)))

    client_names = {c.id: c.name for c in _scoped(db.query(Client), Client).all()}
    rows, matched = [], 0
    props = (
        _scoped(db.query(Property), Property)
        .filter(Property.active == True)  # noqa: E712
        .order_by(Property.name)
        .all()
    )
    for p in props:
        cn = client_names.get(p.client_id)
        candidates = [p.name] + ([cn] if cn else [])
        jid = match_job_id(idx, candidates)
        if jid:
            matched += 1
        rows.append({
            "property": p.name,
            "client": cn,
            "matched_job_id": jid,
            "matched_job_name": (jobs.get(jid, {}) or {}).get("name") if jid else None,
        })

    return {
        "configured": True,
        "job_count": len(ct_jobs),
        "jobs": ct_jobs[:500],
        "properties": rows,
        "matched": matched,
        "unmatched": len(rows) - matched,
    }


# ── Self-serve Google OAuth ── connect an admin's work Google account in-app.
@router.get("/google/connect", dependencies=[Depends(require_role("admin"))])
def google_connect(request: Request, db: Session = Depends(get_db)):
    """Start the OAuth web flow. Returns the Google consent URL the browser
    should navigate to. A one-time state nonce is stored to verify the callback."""
    import secrets
    from integrations.google_oauth import build_flow, is_oauth_available
    if not is_oauth_available():
        raise HTTPException(
            status_code=400,
            detail="Google OAuth client isn't configured on the server. Add a "
                   "Web OAuth client via GOOGLE_CREDENTIALS_B64 (or GOOGLE_CLIENT_ID/"
                   "GOOGLE_CLIENT_SECRET) and set the redirect URI to "
                   "/api/settings/google/callback.",
        )
    state = secrets.token_urlsafe(24)
    set_setting(db, "google_oauth_state", state)
    # Remember where to send the operator back to (the app origin they came from).
    set_setting(db, "google_oauth_return", request.headers.get("referer") or "")
    db.commit()
    flow = build_flow(request, state=state)
    auth_url, _ = flow.authorization_url(
        access_type="offline",          # get a refresh token
        include_granted_scopes="true",
        prompt="consent",               # ensure a refresh token is returned
    )
    return {"auth_url": auth_url}


@router.get("/google/callback")
def google_callback(request: Request, code: str = "", state: str = "", db: Session = Depends(get_db)):
    """OAuth redirect target. Verifies the state nonce, exchanges the code for a
    token, persists it (app_settings 'google_token'), then bounces back to the app."""
    from fastapi.responses import RedirectResponse
    from integrations.google_oauth import build_flow

    saved = get_setting(db, "google_oauth_state")
    if not state or not saved or state != saved:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state.")

    try:
        flow = build_flow(request, state=state)
        # Bounded timeout — same rationale as the auth-router callbacks: a
        # hung Google token endpoint shouldn't wedge this worker forever.
        flow.fetch_token(code=code, timeout=10)
        creds = flow.credentials
    except Exception as e:
        logger.warning(f"Google OAuth callback failed: {e}")
        raise HTTPException(status_code=400, detail="Google authorization failed. Please try connecting again.")

    set_setting(db, "google_token", creds.to_json())
    set_setting(db, "google_oauth_state", "")
    ret = get_setting(db, "google_oauth_return") or "/"
    db.commit()

    target = ret or "/"
    sep = "&" if "?" in target else "?"
    return RedirectResponse(url=f"{target}{sep}gcal=connected", status_code=302)


@router.get("/gcal-embed")
def get_gcal_embed(overlay: str = "", db: Session = Depends(get_db)):
    """Embeddable Google Calendar URL for the in-app calendar views.
    Returns the computed embed_url plus the raw saved override (so the Settings
    field can show/edit it).

    overlay="all" → the dedicated Calendar page wants EVERY calendar stacked
    (the work account's primary + each configured GCAL_*), ignoring the single
    pasted override so nothing is hidden."""
    url = _build_gcal_overlay_all(db) if overlay == "all" else _build_gcal_embed_url(db)
    return {
        "embed_url": url,
        "configured": bool(url),
        "override": (get_setting(db, "gcal_embed_url") or ""),
    }


def _extract_embed_src(value: str) -> str:
    """Accept either a bare embed URL or a full <iframe ...> tag (what Google
    Calendar's "Integrate calendar" gives you) and return just the embed URL."""
    import re
    v = (value or "").strip()
    if "<iframe" in v.lower():
        m = re.search(r'src=["\']([^"\']+)["\']', v, re.IGNORECASE)
        if m:
            v = m.group(1)
    return v.strip()


@router.post("/gcal-embed", dependencies=[Depends(require_role("admin"))])
def save_gcal_embed(config: GcalEmbedConfig, db: Session = Depends(get_db)):
    """Set (or clear) the Google Calendar embed URL. Accepts a pasted <iframe>
    tag or a bare URL; only google.com calendar embed URLs are stored (it's
    rendered in an iframe, so we don't allow arbitrary src values)."""
    val = _extract_embed_src(config.embed_url)
    if val and not val.startswith("https://calendar.google.com/"):
        raise HTTPException(400, "Must be a Google Calendar embed URL (or <iframe> with one)")
    set_setting(db, "gcal_embed_url", val)
    db.commit()
    return {"ok": True, "embed_url": _build_gcal_embed_url(db)}


# ── Automation settings (iCal / GCal auto-sync flags + intervals) ──────────

class AutomationConfig(BaseModel):
    ical_auto_sync_enabled: Optional[bool] = None
    ical_sync_interval: Optional[int] = None
    gcal_auto_sync_enabled: Optional[bool] = None
    gcal_sync_interval: Optional[int] = None
    recurring_auto_generate_enabled: Optional[bool] = None
    invite_customers: Optional[bool] = None
    # Whether Google EMAILS the customer when their cleaning is booked / moved /
    # cancelled (the calendar `sendUpdates` control). Separate from
    # invite_customers: you can put the cleaning on their calendar without
    # emailing them on every change. Turn off to cut notification noise.
    notify_customers: Optional[bool] = None
    # How reminders are set on the Google Calendar event: "google_default"
    # (use the reminders you've configured in Google Calendar), "off" (no
    # event reminders), or "email_popup" (email 24h + popup 1h before).
    gcal_reminders_mode: Optional[str] = None
    # Who wins when the same appointment differs between BrightBase and Google:
    # "brightbase" (default) = your schedule is the master; edits made directly
    # in Google are ignored and re-asserted. "google" = two-way; a time/title
    # edit made in Google syncs BACK into BrightBase. Cancellations always sync
    # both ways regardless.
    calendar_source_of_truth: Optional[str] = None
    # Real-time Google→BrightBase sync via push channels (webhook). When on,
    # external edits reflect in seconds instead of on the ~poll interval. Needs
    # a public https base URL.
    gcal_live_sync: Optional[bool] = None
    # Whether assigning cleaners auto-pushes their Connecteam shifts. OFF =
    # manual dispatch (you press "Dispatch" when ready).
    connecteam_auto_dispatch_enabled: Optional[bool] = None
    # Durability: route Connecteam shift sync through the transactional outbox
    # (rollback-safe, deduplicated, retried) instead of inline API calls. OFF by
    # default; env CONNECTEAM_OUTBOX_ENABLED overrides this DB toggle.
    connecteam_outbox_enabled: Optional[bool] = None
    customer_self_reschedule: Optional[bool] = None
    # STR turnover lead-time guardrail (Tier 3 roadmap): warn when a turnover
    # ends less than this many hours before the next guest's check-in.
    turnover_lead_buffer_hours: Optional[float] = None


def customer_invites_enabled(db: Session) -> bool:
    """Whether to add the customer as an attendee on their cleaning's Google
    Calendar event (so they get an invite email and see it on their calendar).
    Defaults on — it's the headline "customers see their cleanings" behavior —
    and is the in-app kill switch (Settings → Automation)."""
    return _coerce_bool(get_setting(db, "invite_customers"), True)


def customer_notify_enabled(db: Session) -> bool:
    """Whether Google should EMAIL the customer when their cleaning is created,
    rescheduled, or cancelled (the calendar `sendUpdates="all"` vs "none").
    Defaults on. Separate knob from `invite_customers` so the operator can keep
    the cleaning on the customer's calendar while dialing DOWN how many change
    emails Google sends them (Settings → Automation)."""
    return _coerce_bool(get_setting(db, "notify_customers"), True)


# Valid reminder modes for the Google Calendar event.
_GCAL_REMINDER_MODES = ("google_default", "off", "email_popup")


def gcal_reminder_overrides(db: Session):
    """The `reminders` block to put on a Google Calendar event, per the operator's
    Settings → Automation choice:

      - "google_default" (default): {"useDefault": True} — respect whatever
        reminders the operator has configured in Google Calendar itself, so
        reminders are controlled in ONE place (Google) rather than hard-coded.
      - "off": no reminders on the event at all.
      - "email_popup": email 24h before + popup 1h before (the legacy behavior).
    """
    mode = (get_setting(db, "gcal_reminders_mode") or "google_default").strip().lower()
    if mode not in _GCAL_REMINDER_MODES:
        mode = "google_default"
    if mode == "off":
        return {"useDefault": False, "overrides": []}
    if mode == "email_popup":
        return {"useDefault": False, "overrides": [
            {"method": "email", "minutes": 24 * 60},
            {"method": "popup", "minutes": 60},
        ]}
    return {"useDefault": True}


def connecteam_auto_dispatch_enabled(db: Session) -> bool:
    """Whether creating/editing/generating a job AUTOMATICALLY pushes its
    Connecteam shift(s) — live, the way jobs write straight to Google Calendar.
    ON by default: building the schedule in BrightBase pushes DRAFT shifts to
    Connecteam (open for turnovers/unassigned, assigned otherwise) for the
    office to publish. Turn OFF for manual mode, where nothing reaches
    Connecteam until you hit "Dispatch." A reschedule of an already-dispatched
    job re-syncs its shift regardless. Settings → Automation / Schedule."""
    return _coerce_bool(get_setting(db, "connecteam_auto_dispatch_enabled"), True)


def connecteam_outbox_enabled(db: Session) -> bool:
    """Whether Connecteam shift sync routes through the transactional outbox
    (durability hardening) instead of calling the API inline.

    OFF by default so the existing inline dispatch is unchanged until an
    operator opts in. When ON, job-change paths enqueue a sync intent in the
    same transaction as the job change (rollback-safe, deduplicated), and the
    reconcile drain performs the Connecteam call exactly once — making a
    duplicate shift structurally impossible for enqueued syncs.
    Env override: CONNECTEAM_OUTBOX_ENABLED. Settings → Automation."""
    import os
    env = os.getenv("CONNECTEAM_OUTBOX_ENABLED")
    if env is not None:
        return _coerce_bool(env, False)
    return _coerce_bool(get_setting(db, "connecteam_outbox_enabled"), False)


def freebusy_check_enabled(db: Session) -> bool:
    """Whether to check Google Free/Busy when scheduling and block a booking that
    would land on an already-busy slot (overridable per-booking via
    allow_conflicts). Defaults on; in-app kill switch lives in
    Settings → Automation. No-ops cleanly when Google isn't connected."""
    return _coerce_bool(get_setting(db, "freebusy_check"), True)


def customer_self_reschedule_enabled(db: Session) -> bool:
    """Whether customers can move their own upcoming visit from the confirm link
    (pick a new open day + arrival window) instead of only sending a reschedule
    request for staff to action by hand. Defaults on — it's the headline
    "customers reschedule themselves" behavior — and is the in-app kill switch
    (Settings → Automation). When off, the public page falls back to the
    request-only flow."""
    return _coerce_bool(get_setting(db, "customer_self_reschedule"), True)


def turnover_lead_buffer_hours(db: Session) -> float:
    """Minimum acceptable gap (hours) between a turnover's scheduled end and
    the next guest's check-in before the schedule flags it as a tight
    turnaround (Tier 3 roadmap's lead-time guardrail). Configurable in
    Settings → Automation; defaults to 3h."""
    return _coerce_float(get_setting(db, "turnover_lead_buffer_hours"), 3.0)


AUTOMATION_DEFAULTS = {
    "ical_auto_sync_enabled": True,
    "ical_sync_interval": 15,
    "gcal_auto_sync_enabled": True,
    "gcal_sync_interval": 10,
}


def _coerce_bool(v: Optional[str], default: bool) -> bool:
    if v is None:
        return default
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def _coerce_int(v: Optional[str], default: int) -> int:
    try:
        return int(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _coerce_float(v: Optional[str], default: float) -> float:
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


@router.get("/messaging-status")
def messaging_status(db: Session = Depends(get_db)):
    """Live state of AUTOMATIC customer-facing messaging — for an at-a-glance
    "are we texting customers?" indicator.

    The ONLY automatic path that can message a customer is the job SMS reminder
    tick. Post-T-04 the tick is always registered by scheduler.start_scheduler;
    the DB app_setting `job_sms_reminders_enabled` (Meg's toggle in Settings)
    decides whether it sends. `JOB_SMS_REMINDERS_ENABLED=0` remains as a
    deployment-side hard-off (compliance / dev) — reported as env_disabled.

    Manual sends (per-appointment invite, invoice, inbox reply) are
    operator-initiated and intentionally not reflected here.
    """
    # Same authoritative env parser the reminder tick uses (scheduler.py).
    # Sharing the helper is what Codex flagged on #520: a locally-inlined
    # version drifted from the tick's env_flag() semantics, so a stray env
    # value ("foo", empty-with-whitespace) could disable the tick while
    # this endpoint still reported reminders ON.
    from scheduler import env_hard_off as _env_hard_off
    hard_off = _env_hard_off("JOB_SMS_REMINDERS_ENABLED")
    db_on = _coerce_bool(get_setting(db, "job_sms_reminders_enabled"), False)
    sms_reminders = (not hard_off) and db_on
    # Invoice dunning (T-03) shares the same shape.
    dunning_hard_off = _env_hard_off("JOB_DUNNING_ENABLED")
    dunning_db_on = _coerce_bool(get_setting(db, "dunning_enabled"), False)
    dunning_on = (not dunning_hard_off) and dunning_db_on

    return {
        "customer_sms_reminders": sms_reminders,
        # Kept for backwards compatibility with existing consumers that read
        # this field to render SMS-specific copy. Do NOT broaden it to
        # include dunning — the Automation tab keys the "Currently ON /
        # customers receive automatic SMS reminders" line off of it, and
        # widening the semantics made the SMS row lie whenever only
        # dunning was on. Downstream summary tiles that want a broader
        # "any automated touch is active" signal should use
        # `customer_sms_reminders || invoice_dunning`.
        "any_automatic_customer_messaging": sms_reminders,
        # Expose the reason a truthy DB setting is still off so the
        # Automation tab can show "disabled at the deploy layer" instead of
        # a silent false ON.
        "env_disabled": hard_off,
        "invoice_dunning": dunning_on,
        "invoice_dunning_env_disabled": dunning_hard_off,
    }


class MessagingConfig(BaseModel):
    """Two independent toggles for automated customer touches. Missing
    fields leave the current DB setting untouched so a partial POST from
    the UI doesn't silently reset the other channel."""
    customer_sms_reminders: Optional[bool] = None
    invoice_dunning: Optional[bool] = None


@router.post("/messaging", dependencies=[Depends(require_role("admin"))])
def set_messaging(config: MessagingConfig, db: Session = Depends(get_db)):
    """Turn the automatic customer touches on/off from the UI.

    Writes the `job_sms_reminders_enabled` and/or `dunning_enabled`
    app-settings, which the ticks check every run — so setting either
    false stops that stream immediately, even if the matching env flag
    is on (no redeploy needed). This is the in-app kill switch for
    customer messaging."""
    if config.customer_sms_reminders is not None:
        set_setting(db, "job_sms_reminders_enabled",
                    "true" if config.customer_sms_reminders else "false")
    if config.invoice_dunning is not None:
        set_setting(db, "dunning_enabled",
                    "true" if config.invoice_dunning else "false")
    db.commit()
    return messaging_status(db)


@router.get("/automation")
def get_automation_settings(db: Session = Depends(get_db)):
    """Read iCal / GCal auto-sync flags from app_settings, with env fallbacks."""
    import os
    return {
        "ical_auto_sync_enabled": _coerce_bool(
            get_setting(db, "ical_auto_sync_enabled"),
            os.getenv("ICAL_AUTO_SYNC_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"},
        ),
        "ical_sync_interval": _coerce_int(
            get_setting(db, "ical_sync_interval"),
            int(os.getenv("ICAL_AUTO_SYNC_INTERVAL_MINUTES", "15") or 15),
        ),
        "gcal_auto_sync_enabled": _coerce_bool(
            get_setting(db, "gcal_auto_sync_enabled"),
            os.getenv("GCAL_AUTO_SYNC_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"},
        ),
        "gcal_sync_interval": _coerce_int(
            get_setting(db, "gcal_sync_interval"),
            int(os.getenv("GCAL_AUTO_SYNC_INTERVAL_MINUTES", "10") or 10),
        ),
        "recurring_auto_generate_enabled": _coerce_bool(
            get_setting(db, "recurring_auto_generate_enabled"),
            os.getenv("RECURRING_AUTO_GENERATE_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"},
        ),
        "invite_customers": customer_invites_enabled(db),
        "notify_customers": customer_notify_enabled(db),
        "gcal_reminders_mode": (get_setting(db, "gcal_reminders_mode") or "google_default"),
        "calendar_source_of_truth": (get_setting(db, "calendar_source_of_truth")
                                     or os.getenv("CALENDAR_SOURCE_OF_TRUTH", "brightbase")).strip().lower(),
        # Recommended default: real-time sync ON (works out of the box when
        # Google is connected). Explicitly saving it off wins.
        "gcal_live_sync": _coerce_bool(
            get_setting(db, "gcal_live_sync"),
            os.getenv("GCAL_WATCH_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}),
        "connecteam_auto_dispatch_enabled": connecteam_auto_dispatch_enabled(db),
        "connecteam_outbox_enabled": connecteam_outbox_enabled(db),
        "customer_self_reschedule": customer_self_reschedule_enabled(db),
        "turnover_lead_buffer_hours": turnover_lead_buffer_hours(db),
    }


@router.post("/automation", dependencies=[Depends(require_role("admin"))])
def save_automation_settings(config: AutomationConfig, db: Session = Depends(get_db)):
    """Persist iCal / GCal auto-sync flags to app_settings. Only set provided keys."""
    data = config.model_dump(exclude_none=True)
    for key, value in data.items():
        set_setting(db, key, str(value).lower() if isinstance(value, bool) else str(value))
    db.commit()
    logger.info("automation settings saved: %s", data)

    # Turning real-time sync ON registers the Google push channels right away
    # (instead of waiting for the renewal tick), so it starts working
    # immediately. Best-effort — a failure (no public URL / Google not
    # connected) is surfaced to the UI, not raised.
    live_sync_result = None
    if data.get("gcal_live_sync") is True:
        try:
            from integrations.gcal_watch import register_watches
            from config import app_base_url
            live_sync_result = register_watches(db, app_base_url())
        except Exception as e:
            logger.warning("gcal live-sync registration failed: %s", e)
            live_sync_result = {"ok": False, "error": str(e)}

    out = {"status": "saved", **data}
    if live_sync_result is not None:
        out["live_sync"] = live_sync_result
    return out


# ---------- Quote Templates ----------
import json as _json

DEFAULT_QUOTE_TEMPLATES = [
    {"id": "biweekly_residential", "label": "Biweekly Residential", "service_type": "residential",
     "items": [{"name": "Biweekly home clean", "description": "Recurring biweekly residential cleaning", "qty": 1, "unit_price": 185}]},
    {"id": "weekly_residential", "label": "Weekly Residential", "service_type": "residential",
     "items": [{"name": "Weekly home clean", "description": "Recurring weekly residential cleaning", "qty": 1, "unit_price": 165}]},
    {"id": "str_turnover", "label": "STR Turnover", "service_type": "str",
     "items": [{"name": "Airbnb / VRBO turnover", "description": "Strip beds, clean kitchen + baths, restock linens between guests", "qty": 1, "unit_price": 145}]},
    {"id": "one_time_deep", "label": "One-Time Deep Clean", "service_type": "residential",
     "items": [{"name": "Deep clean (one-time)", "description": "Full top-to-bottom deep clean of the home", "qty": 1, "unit_price": 425}]},
    {"id": "move_in_out", "label": "Move-In / Move-Out", "service_type": "residential",
     "items": [{"name": "Move-in / move-out clean", "description": "Empty-home top-to-bottom clean, inside cabinets, appliances, baseboards", "qty": 1, "unit_price": 525}]},
    {"id": "office_clean", "label": "Commercial / Office", "service_type": "commercial",
     "items": [{"name": "Office clean", "description": "Recurring office cleaning - trash, restrooms, vacuum, kitchen", "qty": 1, "unit_price": 295}]},
]


@router.get("/quote-templates")
def get_quote_templates(db: Session = Depends(get_db)):
    """Return the saved quote templates list. Seeds with defaults if empty."""
    row = db.query(AppSetting).filter(AppSetting.key == "quote_templates").first()
    if row and row.value:
        try:
            templates = _json.loads(row.value)
            if isinstance(templates, list):
                return {"templates": templates}
        except Exception as e:
            logger.warning(f"Bad quote_templates JSON, falling back to defaults: {e}")
    return {"templates": DEFAULT_QUOTE_TEMPLATES}


class QuoteTemplateItemBody(BaseModel):
    name: str
    description: Optional[str] = ""
    qty: float = 1
    unit_price: float = 0


class QuoteTemplateBody(BaseModel):
    id: str
    label: str
    service_type: str
    items: list


class QuoteTemplatesUpdate(BaseModel):
    templates: list


@router.put("/quote-templates", dependencies=[Depends(require_role("admin", "manager"))])
def update_quote_templates(body: QuoteTemplatesUpdate, db: Session = Depends(get_db)):
    """Overwrite the quote templates list. Caller sends the full array."""
    if not isinstance(body.templates, list):
        raise HTTPException(400, "templates must be an array")
    # Light validation — every template needs id + label + items list
    for i, t in enumerate(body.templates):
        if not isinstance(t, dict) or not t.get("id") or not t.get("label"):
            raise HTTPException(400, f"Template #{i + 1} is missing id or label")
        if not isinstance(t.get("items"), list) or not t["items"]:
            raise HTTPException(400, f"Template \"{t.get('label') or t.get('id')}\" needs at least one line item")
    payload = _json.dumps(body.templates)
    row = db.query(AppSetting).filter(AppSetting.key == "quote_templates").first()
    if row:
        row.value = payload
    else:
        row = AppSetting(key="quote_templates", value=payload)
        db.add(row)
    db.commit()
    return {"templates": body.templates, "saved": True}


# ---------- Service Scopes ----------
# The editable list of services the company offers, with the customer-facing
# "what's included" scope for each. This drives BOTH the service-type selector
# and the scope pre-fill when creating a quote. Stored as ONE JSON app-setting
# (list of {key,label,scope}) so operators can ADD services — the old fixed
# service_scope_residential/commercial/str keys couldn't represent that.
#
# Defaults mirror the scope-of-services shown on maineclean.co so the quote a
# customer receives matches what the website promised.
DEFAULT_SERVICE_SCOPES = [
    {
        "key": "residential",
        "label": "Recurring Maintenance Clean",
        "scope": (
            "Ongoing upkeep to keep your home consistently clean between visits.\n\n"
            "Kitchen: countertops and backsplash wiped and sanitized, sink scrubbed, "
            "exterior of all appliances, stovetop degreased, microwave inside and out, "
            "cabinet fronts spot-cleaned, floors swept and mopped, trash emptied.\n"
            "Bathrooms: toilets cleaned and sanitized inside and out, showers/tubs/glass "
            "scrubbed, sinks and vanities wiped, mirrors and chrome polished, floors washed, "
            "trash emptied.\n"
            "Bedrooms and living areas: dust all reachable surfaces, furniture, decor and "
            "sills, beds made or linens changed, carpets and rugs vacuumed, hard floors swept "
            "and mopped, mirrors and glass.\n"
            "Whole home: high-touch points (switches, handles, knobs), baseboards and trim "
            "dusted as needed, general tidy and reset."
        ),
    },
    {
        "key": "deep",
        "label": "Deep Clean",
        "scope": (
            "A detailed, top-to-bottom clean covering everything in the Maintenance Clean "
            "plus the build-up areas routine service doesn't reach. Recommended for a first "
            "visit.\n\n"
            "Includes everything in the Maintenance Clean, plus:\n"
            "- Baseboards, trim, and door frames detailed\n"
            "- Interior windows, sills, and tracks\n"
            "- Blinds and window treatments dusted\n"
            "- Light fixtures and ceiling fans\n"
            "- Wall spot-cleaning and cobweb removal\n"
            "- Cabinet fronts and hardware detailed\n"
            "- Tile and grout detail in kitchen and baths\n"
            "- Behind and under movable furniture and appliances\n"
            "- Inside oven, refrigerator, or cabinets (available on request)"
        ),
    },
    {
        "key": "move_in_out",
        "label": "Move-In / Move-Out Clean",
        "scope": (
            "A complete clean of an empty property, prepared for new occupants or a final "
            "walkthrough.\n\n"
            "Includes everything in the Deep Clean, plus:\n"
            "- Inside all cabinets, drawers, and closets\n"
            "- Inside oven and refrigerator\n"
            "- All appliance interiors and exteriors\n"
            "- Interior windows throughout\n"
            "- Full baseboard, trim, and door detail in every room\n"
            "- Doors, handles, and switch plates throughout"
        ),
    },
    {
        "key": "str",
        "label": "Short-Term Rental Turnover",
        "scope": (
            "A full guest-ready reset between stays, cleaned and staged to listing standard.\n\n"
            "Reset and clean: strip and remake all beds with fresh linens, full bathroom clean, "
            "sanitize and restock, kitchen cleaned and dishes done, all floors vacuumed and "
            "mopped, surfaces dusted and sanitized, trash and recycling removed.\n"
            "Restock and stage: replenish provided consumables (paper products, soap, coffee, "
            "amenities), reset furniture and staging to listing photos, final walkthrough for "
            "guest-ready presentation.\n"
            "Inspection and reporting: damage and inventory check, photograph and report any "
            "issues or missing items, flag low or out-of-stock supplies.\n"
            "Linens and laundry: on-site laundering of sheets and towels, or fresh linen swap "
            "where provided."
        ),
    },
    {
        "key": "commercial",
        "label": "Commercial Cleaning",
        "scope": (
            "Recurring cleaning of your business space on a nightly, weekly, or custom "
            "schedule.\n\n"
            "- Restroom sanitization and restocking of consumables\n"
            "- Break room and kitchen detailing\n"
            "- Workstation dusting and sanitizing\n"
            "- Hard floor care and maintenance\n"
            "- Waste and recycling management\n"
            "- High-touch surfaces and entryways"
        ),
    },
]

# Legacy fixed keys -> new list key, so an operator's earlier edits in
# Settings → General → Service Descriptions carry over to the new editor.
_LEGACY_SCOPE_KEYS = {
    "residential": "service_scope_residential",
    "commercial": "service_scope_commercial",
    "str": "service_scope_str",
}


def service_scopes_list(db: Session) -> list:
    """The saved service scopes, or defaults (with any legacy per-service
    edits overlaid) when nothing's been saved yet."""
    row = db.query(AppSetting).filter(AppSetting.key == "service_scopes").first()
    if row and row.value:
        try:
            data = _json.loads(row.value)
            if isinstance(data, list) and data:
                return data
        except Exception as e:
            logger.warning(f"Bad service_scopes JSON, falling back to defaults: {e}")
    # First run: seed from defaults, overlaying any legacy service_scope_* the
    # operator had customized so their old edits aren't lost.
    seeded = [dict(s) for s in DEFAULT_SERVICE_SCOPES]
    for s in seeded:
        legacy_key = _LEGACY_SCOPE_KEYS.get(s["key"])
        if legacy_key:
            legacy_val = get_setting(db, legacy_key)
            if legacy_val and legacy_val.strip():
                s["scope"] = legacy_val.strip()
    return seeded


@router.get("/service-scopes")
def get_service_scopes(db: Session = Depends(get_db)):
    """The editable list of services + their customer-facing scope. Seeds with
    website-matched defaults (plus any legacy edits) when nothing is saved."""
    return {"services": service_scopes_list(db)}


class ServiceScopeBody(BaseModel):
    key: str
    label: str
    scope: Optional[str] = ""


class ServiceScopesUpdate(BaseModel):
    services: list


_SCOPE_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")


@router.put("/service-scopes", dependencies=[Depends(require_role("admin", "manager"))])
def update_service_scopes(body: ServiceScopesUpdate, db: Session = Depends(get_db)):
    """Overwrite the service scopes list. Caller sends the full array of
    {key,label,scope}. Keys must be unique, url-safe slugs (they become the
    quote's service_type)."""
    if not isinstance(body.services, list) or not body.services:
        raise HTTPException(400, "At least one service is required")
    seen = set()
    cleaned = []
    for i, s in enumerate(body.services):
        if not isinstance(s, dict):
            raise HTTPException(400, f"Service #{i + 1} is malformed")
        key = (s.get("key") or "").strip().lower()
        label = (s.get("label") or "").strip()
        scope = (s.get("scope") or "").strip()
        if not key or not _SCOPE_KEY_RE.match(key):
            raise HTTPException(400, f"Service #{i + 1} needs a url-safe key (lowercase letters, numbers, - or _)")
        if not label:
            raise HTTPException(400, f'Service "{key}" needs a label')
        if key in seen:
            raise HTTPException(400, f'Duplicate service key "{key}"')
        seen.add(key)
        cleaned.append({"key": key, "label": label, "scope": scope})
    payload = _json.dumps(cleaned)
    row = db.query(AppSetting).filter(AppSetting.key == "service_scopes").first()
    if row:
        row.value = payload
    else:
        row = AppSetting(key="service_scopes", value=payload)
        db.add(row)
    db.commit()
    return {"services": cleaned, "saved": True}
