"""
App Settings Router - email/IMAP credentials, integrations, etc.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database.db import get_db
from database.models import AppSetting
from modules.auth.router import require_role
import imaplib
import smtplib
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

SENSITIVE_KEYS = {"smtp_pass", "imap_pass"}
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


@router.get("")
def get_all_settings(db: Session = Depends(get_db)):
    rows = db.query(AppSetting).all()
    result = {}
    for row in rows:
        if row.key in SENSITIVE_KEYS:
            result[row.key] = "****" + row.value[-4:] if row.value and len(row.value) > 4 else "****"
        else:
            result[row.key] = row.value
    return result


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


# ── Automation settings (iCal / GCal auto-sync flags + intervals) ──────────

class AutomationConfig(BaseModel):
    ical_auto_sync_enabled: Optional[bool] = None
    ical_sync_interval: Optional[int] = None
    gcal_auto_sync_enabled: Optional[bool] = None
    gcal_sync_interval: Optional[int] = None
    recurring_auto_generate_enabled: Optional[bool] = None


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
