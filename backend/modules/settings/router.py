"""
App Settings Router
Manages global config: email/IMAP credentials, integrations, etc.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Dict
from database.db import get_db
from database.models import AppSetting
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


@router.get("/email")
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


@router.post("/email")
def save_email_settings(config: EmailConfig, db: Session = Depends(get_db)):
    data = config.model_dump(exclude_none=True)
    for key, value in data.items():
        if key in SENSITIVE_KEYS and value and value.startswith("****"):
            continue
        set_setting(db, key, str(value))
    db.commit()
    return {"status": "saved"}


@router.post("/email/test")
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
