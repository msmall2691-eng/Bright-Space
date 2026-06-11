"""Per-user Gmail sync over the Gmail API (phase C of
docs/auth-workspaces-plan-2026-06.md).

Each member's connected Google account (user_google_accounts) reads its OWN
inbox with the gmail.readonly scope granted in the Connect flow — no App
Password involved. Returns email dicts in the exact shape
integrations.gmail_inbox.fetch_inbox produces, so the comms threading
pipeline (modules.gmail.router.run_inbox_sync) is shared between the legacy
IMAP path (kept as the business-inbox fallback, by decision) and this one.
"""
import base64
import logging
import re
from email.utils import parseaddr, parsedate_to_datetime

from googleapiclient.discovery import build

from integrations.gmail_inbox import _is_automated

logger = logging.getLogger(__name__)


def _header(headers: list, name: str) -> str:
    name = name.lower()
    for h in headers or []:
        if (h.get("name") or "").lower() == name:
            return h.get("value") or ""
    return ""


def _walk_parts(payload: dict):
    yield payload
    for p in payload.get("parts") or []:
        yield from _walk_parts(p)


def _body_text(payload: dict) -> str:
    """Prefer text/plain; fall back to stripped text/html."""
    plain, html = "", ""
    for part in _walk_parts(payload or {}):
        data = (part.get("body") or {}).get("data")
        if not data:
            continue
        try:
            text = base64.urlsafe_b64decode(data.encode()).decode("utf-8", errors="replace")
        except Exception:
            continue
        mime = part.get("mimeType") or ""
        if mime == "text/plain" and not plain:
            plain = text
        elif mime == "text/html" and not html:
            html = text
    if plain:
        return plain
    return re.sub(r"<[^>]+>", " ", html)


def fetch_inbox_for_account(creds, max_results: int = 30, skip_automated: bool = True) -> list:
    """Fetch the most recent inbox messages for a connected account.

    `creds` is a live google.oauth2 Credentials (from
    integrations.google_accounts.account_credentials). Dedup against already
    threaded messages happens downstream on the Message-ID header, same as
    the IMAP path.
    """
    service = build("gmail", "v1", credentials=creds)
    listing = service.users().messages().list(
        userId="me", labelIds=["INBOX"], maxResults=max_results,
    ).execute()
    out = []
    for ref in listing.get("messages", []) or []:
        try:
            msg = service.users().messages().get(userId="me", id=ref["id"], format="full").execute()
        except Exception as e:
            logger.warning(f"[gmail-api] could not fetch message {ref.get('id')}: {e}")
            continue
        headers = (msg.get("payload") or {}).get("headers") or []
        from_name, from_email = parseaddr(_header(headers, "From"))
        if not from_email:
            continue
        if skip_automated and _is_automated(from_email):
            continue
        date_raw = _header(headers, "Date")
        try:
            date_iso = parsedate_to_datetime(date_raw).isoformat() if date_raw else ""
        except Exception:
            date_iso = ""
        body = _body_text(msg.get("payload") or {})
        out.append({
            "id": msg.get("id"),
            "message_id": _header(headers, "Message-ID"),
            "from_name": from_name or from_email.split("@")[0],
            "from_email": from_email.lower(),
            "to": _header(headers, "To"),
            "subject": _header(headers, "Subject"),
            "snippet": msg.get("snippet") or "",
            "body": body,
            "date": date_iso,
            "is_read": "UNREAD" not in (msg.get("labelIds") or []),
            "has_attachments": any(
                (p.get("filename") or "").strip() for p in _walk_parts(msg.get("payload") or {})
            ),
        })
    return out
