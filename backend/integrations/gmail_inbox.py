"""
Gmail Inbox Integration via IMAP
Uses existing SMTP credentials (App Password) to read emails.
No additional OAuth required.
"""
import imaplib
import email as email_lib
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone
import os, re, logging

logger = logging.getLogger(__name__)

IMAP_HOST = os.getenv("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.getenv("IMAP_PORT", "993"))
SMTP_USER = os.getenv("SMTP_USER", "") or os.getenv("GMAIL_EMAIL", "")
SMTP_PASS = os.getenv("SMTP_PASS", "") or os.getenv("GMAIL_PASSWORD", "")

# Patterns to filter out automated / newsletter emails
AUTOMATED_PATTERNS = [
    r"noreply@", r"no-reply@", r"donotreply@",
    r"notifications?@", r"alerts?@", r"mailer-daemon@",
    r"newsletter@", r"updates?@",
    r"@github\.com$", r"@linkedin\.com$",
    r"@facebookmail\.com$", r"@youtube\.com$",
    r"@amazonses\.com$", r"@mailchimp\.com$",
    r"@sendgrid\.", r"@constantcontact\.com$",
    r"@vercel\.com$", r"@railway\.app$",
    r"@google\.com$", r"@googlemail\.com$",
    r"@supabase\.", r"@stripe\.com$",
]


def _is_automated(from_email: str) -> bool:
    addr = from_email.lower()
    for pat in AUTOMATED_PATTERNS:
        if re.search(pat, addr):
            return True
    return False


def _decode_hdr(value):
    if not value:
        return ""
    parts = decode_header(value)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(str(part))
    return " ".join(decoded)


def _lead_signal_headers(msg) -> dict:
    """Headers the lead-filter uses to tell real prospects from bulk/automated mail.

    - to_email / in_reply_to / references → is this a reply to a thread we started?
    - list_unsubscribe / precedence / feedback_id / auto_submitted → bulk/marketing
      markers (newsletters, ESP blasts) that should stay inbox-only, never a lead.
    """
    return {
        "to_email": (parseaddr(msg["To"] or "")[1] or "").lower(),
        "in_reply_to": msg["In-Reply-To"] or "",
        "references": msg["References"] or "",
        "list_unsubscribe": msg["List-Unsubscribe"] or "",
        "precedence": (msg["Precedence"] or "").lower(),
        "feedback_id": msg["Feedback-ID"] or "",
        "auto_submitted": (msg["Auto-Submitted"] or "").lower(),
    }



def _get_text_body(msg):
    """Extract plain text body from email message."""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if ct == "text/plain" and "attachment" not in cd:
                try:
                    return part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", errors="replace"
                    )
                except Exception:
                    continue
        # fallback: strip HTML
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                try:
                    html = part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", errors="replace"
                    )
                    text = re.sub(r"<[^>]+>", " ", html)
                    return re.sub(r"\s+", " ", text).strip()
                except Exception:
                    continue
    else:
        try:
            text = msg.get_payload(decode=True).decode(
                msg.get_content_charset() or "utf-8", errors="replace"
            )
            if msg.get_content_type() == "text/html":
                text = re.sub(r"<[^>]+>", " ", text)
                text = re.sub(r"\s+", " ", text).strip()
            return text
        except Exception:
            pass
    return ""


def _has_attachments(msg):
    if msg.is_multipart():
        for part in msg.walk():
            cd = part.get("Content-Disposition")
            if cd and "attachment" in str(cd):
                return True
    return False


def _get_credentials():
    """Get IMAP credentials from DB settings first, fall back to env vars."""
    try:
        from database.db import SessionLocal
        from database.models import AppSetting
        db = SessionLocal()
        try:
            user_row = db.query(AppSetting).filter(AppSetting.key == "smtp_user").first()
            pass_row = db.query(AppSetting).filter(AppSetting.key == "smtp_pass").first()
            host_row = db.query(AppSetting).filter(AppSetting.key == "imap_host").first()
            port_row = db.query(AppSetting).filter(AppSetting.key == "imap_port").first()
            smtp_host_row = db.query(AppSetting).filter(AppSetting.key == "smtp_host").first()
            smtp_port_row = db.query(AppSetting).filter(AppSetting.key == "smtp_port").first()
            user = (user_row.value if user_row and user_row.value else None) or SMTP_USER
            from utils.app_secrets import decode_setting_value
            _raw_pass = pass_row.value if pass_row and pass_row.value else None
            passwd = (decode_setting_value("smtp_pass", _raw_pass) if _raw_pass else None) or SMTP_PASS
            imap_host = (host_row.value if host_row and host_row.value else None) or IMAP_HOST
            imap_port = int((port_row.value if port_row and port_row.value else None) or IMAP_PORT)
            smtp_host = (smtp_host_row.value if smtp_host_row and smtp_host_row.value else None) or "smtp.gmail.com"
            smtp_port = int((smtp_port_row.value if smtp_port_row and smtp_port_row.value else None) or "587")
            return user, passwd, imap_host, imap_port, smtp_host, smtp_port
        finally:
            db.close()
    except Exception:
        return SMTP_USER, SMTP_PASS, IMAP_HOST, IMAP_PORT, "smtp.gmail.com", 587


LAST_SYNCED_SETTING_KEY = "gmail_inbox_last_synced_at"


def get_last_synced_at():
    """ISO date the shared IMAP inbox was last successfully scanned through,
    or None if it's never run (or the DB isn't reachable — same fail-open-
    to-old-behavior pattern as _get_credentials).

    Backs the cursor fix for audit finding #3: fetch_inbox used to only ever
    look at the last max_results*3 messages by IMAP sequence number, so a
    burst of more than that between sync ticks silently skipped anything
    older than the cutoff — including a real lead."""
    try:
        from database.db import SessionLocal
        from database.models import AppSetting
        db = SessionLocal()
        try:
            row = db.query(AppSetting).filter(AppSetting.key == LAST_SYNCED_SETTING_KEY).first()
            return row.value if row and row.value else None
        finally:
            db.close()
    except Exception:
        return None


def set_last_synced_at(value: str) -> None:
    try:
        from database.db import SessionLocal
        from database.models import AppSetting
        db = SessionLocal()
        try:
            row = db.query(AppSetting).filter(AppSetting.key == LAST_SYNCED_SETTING_KEY).first()
            if row:
                row.value = value
            else:
                db.add(AppSetting(key=LAST_SYNCED_SETTING_KEY, value=value))
            db.commit()
        finally:
            db.close()
    except Exception as e:
        logger.warning(f"Could not persist {LAST_SYNCED_SETTING_KEY}: {e}")


def _connect():
    """Create and authenticate IMAP connection using DB or env credentials.

    timeout: without an explicit timeout, `IMAP4_SSL` waits indefinitely
    on connect. A hung Gmail IMAP host (rare but real — TLS handshake
    stalls, DNS timeouts) would block the uvicorn worker forever, which on
    a single-worker deploy queued the entire request stream past Railway's
    edge timeout → 502s. 30s matches the SMTP path (integrations/email.py).
    """
    user, passwd, imap_host, imap_port, _, _ = _get_credentials()
    if not user or not passwd:
        raise ValueError("No email credentials configured")
    imap_timeout = int(os.getenv("IMAP_TIMEOUT_SECONDS", "30"))
    mail = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=imap_timeout)
    mail.login(user, passwd)
    return mail


def fetch_inbox(max_results=30, folder="INBOX", skip_automated=True, since=None):
    """
    Fetch recent emails from Gmail inbox via IMAP.
    Returns list of parsed email dicts sorted newest-first.

    since: an ISO date string (e.g. "2026-07-01"). When given, uses IMAP's
    native SINCE search instead of "last N by sequence number" — a burst of
    more than max_results*3 messages between sync ticks used to silently
    skip anything older than that cutoff, which could be a real lead (audit
    finding #3). IMAP's SINCE is date-granular (whole days, not a
    timestamp), so callers should keep re-supplying the SAME day's date on
    every tick within that day rather than advancing hourly — downstream
    Message-ID dedup makes re-scanning idempotent, so the overlap is free.
    """
    user, passwd, host, port, _, _ = _get_credentials()
    if not user or not passwd:
        logger.warning("Gmail IMAP: No credentials configured (check Settings or env vars)")
        raise ConnectionError("no_credentials")

    try:
        mail = _connect()
        mail.select(folder, readonly=True)

        search_criteria = "ALL"
        if since:
            try:
                since_date = datetime.fromisoformat(since).date()
                search_criteria = f'(SINCE "{since_date.strftime("%d-%b-%Y")}")'
            except ValueError:
                logger.warning(f"Gmail IMAP: bad 'since' cursor {since!r}, scanning ALL instead")

        status, data = mail.search(None, search_criteria)
        if status != "OK" or not data[0]:
            mail.close(); mail.logout()
            return []

        message_ids = data[0].split()
        # A cursor-bounded search is already scoped by date server-side, so
        # widen the client-side cap well past the old fixed window instead
        # of re-imposing the same "only the last N" truncation on top of it.
        fetch_count = max_results * 3 if skip_automated else max_results
        if since:
            fetch_count = max(fetch_count, min(len(message_ids), 500))
        latest_ids = message_ids[-fetch_count:]

        emails = []
        for mid in reversed(latest_ids):
            if len(emails) >= max_results:
                break
            try:
                status, msg_data = mail.fetch(mid, "(RFC822 FLAGS)")
                if status != "OK" or not msg_data or not msg_data[0]:
                    continue

                raw = msg_data[0][1]
                flags_raw = msg_data[0][0].decode() if msg_data[0][0] else ""
                is_read = "\\Seen" in flags_raw

                msg = email_lib.message_from_bytes(raw)

                from_raw = msg["From"] or ""
                from_name, from_email = parseaddr(from_raw)
                from_name = _decode_hdr(from_name) or from_email

                if skip_automated and _is_automated(from_email):
                    continue

                subject = _decode_hdr(msg["Subject"]) or "(No Subject)"
                try:
                    date_dt = parsedate_to_datetime(msg["Date"])
                except Exception:
                    date_dt = datetime.now(timezone.utc)

                body_text = _get_text_body(msg)

                emails.append({
                    "id": mid.decode(),
                    "message_id": msg["Message-ID"] or "",
                    "from_name": from_name,
                    "from_email": from_email.lower(),
                    "to": msg["To"] or "",
                    "subject": subject,
                    "snippet": (body_text[:280].strip() + "...") if len(body_text) > 280 else body_text.strip(),
                    "body": body_text,
                    "date": date_dt.isoformat(),
                    "is_read": is_read,
                    "has_attachments": _has_attachments(msg),
                    **_lead_signal_headers(msg),
                })
            except Exception as e:
                logger.error(f"Error parsing email {mid}: {e}")
                continue

        mail.close()
        mail.logout()
        return emails

    except imaplib.IMAP4.error as e:
        logger.error(f"IMAP auth/connection error: {e}")
        raise ConnectionError(f"imap_auth_failed: {e}")
    except ConnectionError:
        raise
    except Exception as e:
        logger.error(f"Gmail fetch error: {e}")
        raise ConnectionError(f"imap_error: {e}")


def fetch_email_by_id(email_id: str, folder="INBOX"):
    """Fetch a single email by its IMAP sequence number."""
    user, passwd, _, _, _, _ = _get_credentials()
    if not user or not passwd:
        return None
    try:
        mail = _connect()
        mail.select(folder, readonly=True)
        status, msg_data = mail.fetch(email_id.encode(), "(RFC822)")
        if status != "OK" or not msg_data or not msg_data[0]:
            mail.close(); mail.logout()
            return None

        raw = msg_data[0][1]
        msg = email_lib.message_from_bytes(raw)

        from_raw = msg["From"] or ""
        from_name, from_email = parseaddr(from_raw)
        from_name = _decode_hdr(from_name) or from_email
        subject = _decode_hdr(msg["Subject"]) or "(No Subject)"
        try:
            date_dt = parsedate_to_datetime(msg["Date"])
        except Exception:
            date_dt = datetime.now(timezone.utc)

        result = {
            "id": email_id,
            "message_id": msg["Message-ID"] or "",
            "from_name": from_name,
            "from_email": from_email.lower(),
            "to": msg["To"] or "",
            "cc": msg["Cc"] or "",
            "subject": subject,
            "body": _get_text_body(msg),
            "date": date_dt.isoformat(),
            "has_attachments": _has_attachments(msg),
            **_lead_signal_headers(msg),
        }
        mail.close()
        mail.logout()
        return result
    except Exception as e:
        logger.error(f"Error fetching email {email_id}: {e}")
        return None


