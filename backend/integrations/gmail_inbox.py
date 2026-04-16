"""
Gmail Inbox Integration via IMAP
Uses existing SMTP credentials (App Password) to read emails.
No additional OAuth required.
"""
import imaplib
import email as email_lib
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from datetime import datetime, timezone
import os, re, logging

logger = logging.getLogger(__name__)

IMAP_HOST = os.getenv("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.getenv("IMAP_PORT", "993"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")

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
            return msg.get_payload(decode=True).decode(
                msg.get_content_charset() or "utf-8", errors="replace"
            )
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


def _connect():
    """Create and authenticate IMAP connection."""
    mail = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    mail.login(SMTP_USER, SMTP_PASS)
    return mail


def fetch_inbox(max_results=30, folder="INBOX", skip_automated=True):
    """
    Fetch recent emails from Gmail inbox via IMAP.
    Returns list of parsed email dicts sorted newest-first.
    """
    if not SMTP_USER or not SMTP_PASS:
        logger.warning("Gmail IMAP: SMTP_USER or SMTP_PASS not configured")
        return []

    try:
        mail = _connect()
        mail.select(folder, readonly=True)

        status, data = mail.search(None, "ALL")
        if status != "OK" or not data[0]:
            mail.close(); mail.logout()
            return []

        message_ids = data[0].split()
        # Fetch extra to account for automated filtering
        fetch_count = max_results * 3 if skip_automated else max_results
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
                })
            except Exception as e:
                logger.error(f"Error parsing email {mid}: {e}")
                continue

        mail.close()
        mail.logout()
        return emails

    except imaplib.IMAP4.error as e:
        logger.error(f"IMAP auth/connection error: {e}")
        return []
    except Exception as e:
        logger.error(f"Gmail fetch error: {e}")
        return []


def fetch_email_by_id(email_id: str, folder="INBOX"):
    """Fetch a single email by its IMAP sequence number."""
    if not SMTP_USER or not SMTP_PASS:
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
        }
        mail.close()
        mail.logout()
        return result
    except Exception as e:
        logger.error(f"Error fetching email {email_id}: {e}")
        return None
