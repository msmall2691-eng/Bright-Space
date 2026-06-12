"""
App Settings Router - email/IMAP credentials, integrations, etc.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database.db import get_db
from database.models import AppSetting
from modules.auth.router import require_role
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
        mail = imaplib.IMAP4_SSL(imap_host, imap_port)
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
    # Header band color for every customer-facing quote surface.
    brand_color: Optional[str] = None


_GENERAL_KEYS = ("company_name", "company_email", "company_phone",
                 "timezone", "currency", "quote_terms", "brand_color")


@router.get("/general", dependencies=[Depends(require_role("admin", "manager"))])
def get_general_settings(db: Session = Depends(get_db)):
    return {k: get_setting(db, k) for k in _GENERAL_KEYS}


@router.post("/general", dependencies=[Depends(require_role("admin"))])
def save_general_settings(config: GeneralSettings, db: Session = Depends(get_db)):
    """Persist company identity + quote terms. The Settings UI was already
    POSTing here — the endpoint just never existed, so 'Company Information'
    silently failed to save. These rows feed the public quote page and the
    quote email (settings first, env fallback)."""
    for key in _GENERAL_KEYS:
        value = getattr(config, key)
        if value is not None:
            set_setting(db, key, value.strip())
    db.commit()
    return {k: get_setting(db, k) for k in _GENERAL_KEYS}


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
        flow.fetch_token(code=code)
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


def customer_invites_enabled(db: Session) -> bool:
    """Whether to add the customer as an attendee on their cleaning's Google
    Calendar event (so they get an invite email and see it on their calendar).
    Defaults on — it's the headline "customers see their cleanings" behavior —
    and is the in-app kill switch (Settings → Automation)."""
    return _coerce_bool(get_setting(db, "invite_customers"), True)


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


@router.get("/messaging-status")
def messaging_status(db: Session = Depends(get_db)):
    """Live state of AUTOMATIC customer-facing messaging — for an at-a-glance
    "are we texting customers?" indicator.

    The ONLY automatic path that can message a customer is the job SMS reminder
    tick. Crucially, that tick is REGISTERED at boot only when the env flag
    JOB_SMS_REMINDERS_ENABLED is on (scheduler.start_scheduler); the DB setting
    job_sms_reminders_enabled can only *further disable* it from inside the tick.
    So messaging is actually ON iff the env gate is on AND the DB setting hasn't
    turned it off — we report the real scheduler state, not just intent, so a DB
    toggle flipped without the env flag/restart doesn't show a false ON. Manual
    sends (per-appointment invite, invoice, inbox reply) are operator-initiated
    and intentionally not reflected here."""
    import os
    env_on = os.getenv("JOB_SMS_REMINDERS_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}
    sms_reminders = env_on and _coerce_bool(get_setting(db, "job_sms_reminders_enabled"), True)
    return {
        "customer_sms_reminders": sms_reminders,
        "any_automatic_customer_messaging": sms_reminders,
    }


class MessagingConfig(BaseModel):
    customer_sms_reminders: bool


@router.post("/messaging", dependencies=[Depends(require_role("admin"))])
def set_messaging(config: MessagingConfig, db: Session = Depends(get_db)):
    """Turn automatic customer SMS reminders on/off from the UI.

    Writes the job_sms_reminders_enabled app-setting, which the reminder tick
    checks every run — so setting it false stops reminders immediately, even if
    the JOB_SMS_REMINDERS_ENABLED env flag is on (no redeploy needed). This is
    the in-app kill switch for customer messaging."""
    set_setting(db, "job_sms_reminders_enabled", "true" if config.customer_sms_reminders else "false")
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
    }


@router.post("/automation", dependencies=[Depends(require_role("admin"))])
def save_automation_settings(config: AutomationConfig, db: Session = Depends(get_db)):
    """Persist iCal / GCal auto-sync flags to app_settings. Only set provided keys."""
    data = config.model_dump(exclude_none=True)
    for key, value in data.items():
        set_setting(db, key, str(value).lower() if isinstance(value, bool) else str(value))
    db.commit()
    logger.info("automation settings saved: %s", data)
    return {"status": "saved", **data}


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
