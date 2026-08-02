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
import os
import re
from email.utils import parseaddr, parsedate_to_datetime

import httplib2
from google_auth_httplib2 import AuthorizedHttp
from googleapiclient.discovery import build

from integrations.gmail_inbox import _is_automated

logger = logging.getLogger(__name__)

# Bare httplib2.Http() (googleapiclient's default transport) has no socket
# timeout — a hung Gmail API call would wedge the calling uvicorn worker
# forever, the same class of bug fixed for Twilio/SMTP/IMAP/GCal (T-20).
_HTTP_TIMEOUT_SECONDS = int(os.getenv("GCAL_HTTP_TIMEOUT_SECONDS", "20"))


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


def _service(creds):
    """Build a timeout-bounded Gmail API service from live OAuth creds."""
    authed_http = AuthorizedHttp(creds, http=httplib2.Http(timeout=_HTTP_TIMEOUT_SECONDS))
    return build("gmail", "v1", http=authed_http)


def _message_dict(service, msg_id: str, skip_automated: bool = True):
    """Fetch one message by id and shape it like the IMAP path's dict. Returns
    None when the message can't be fetched or is filtered out (no sender /
    automated)."""
    try:
        msg = service.users().messages().get(userId="me", id=msg_id, format="full").execute()
    except Exception as e:
        logger.warning(f"[gmail-api] could not fetch message {msg_id}: {e}")
        return None
    headers = (msg.get("payload") or {}).get("headers") or []
    from_name, from_email = parseaddr(_header(headers, "From"))
    if not from_email:
        return None
    if skip_automated and _is_automated(from_email):
        return None
    date_raw = _header(headers, "Date")
    try:
        date_iso = parsedate_to_datetime(date_raw).isoformat() if date_raw else ""
    except Exception:
        date_iso = ""
    return {
        "id": msg.get("id"),
        "message_id": _header(headers, "Message-ID"),
        "from_name": from_name or from_email.split("@")[0],
        "from_email": from_email.lower(),
        "to": _header(headers, "To"),
        "subject": _header(headers, "Subject"),
        "snippet": msg.get("snippet") or "",
        "body": _body_text(msg.get("payload") or {}),
        "date": date_iso,
        "is_read": "UNREAD" not in (msg.get("labelIds") or []),
        "has_attachments": any(
            (p.get("filename") or "").strip() for p in _walk_parts(msg.get("payload") or {})
        ),
    }


def current_history_id(creds) -> str:
    """The mailbox's current historyId — the cursor a later incremental sync
    reads changes *from*. Called after a full sync to seed the cursor."""
    profile = _service(creds).users().getProfile(userId="me").execute()
    return str(profile.get("historyId") or "")


def send_message(creds, *, to: str, subject: str, html_body: str,
                 from_addr: str = None, in_reply_to: str = None,
                 references: str = None, thread_id: str = None) -> dict:
    """Send an email THROUGH the user's Gmail (users.messages.send) so it lands
    in their Gmail Sent and — with In-Reply-To/References set to the message
    being answered — threads into the existing Gmail conversation, instead of
    going out via SMTP as a disconnected message.

    Returns {"id", "threadId", "message_id"} where message_id is the RFC
    Message-ID header we generated (stored on our outbound Message so a future
    reply threads back and dedup works). Requires the gmail.send scope, which
    the Connect flow already requests."""
    import base64 as _b64
    from email.mime.text import MIMEText
    from email.utils import make_msgid

    mime = MIMEText(html_body or "", "html", "utf-8")
    mime["To"] = to
    mime["Subject"] = subject or ""
    if from_addr:
        mime["From"] = from_addr
    msg_id = make_msgid()
    mime["Message-ID"] = msg_id
    if in_reply_to:
        mime["In-Reply-To"] = in_reply_to
        # References chains the whole thread; fall back to just the parent.
        mime["References"] = references or in_reply_to
    raw = _b64.urlsafe_b64encode(mime.as_bytes()).decode()
    body = {"raw": raw}
    if thread_id:
        body["threadId"] = thread_id
    sent = _service(creds).users().messages().send(userId="me", body=body).execute()
    return {"id": sent.get("id"), "threadId": sent.get("threadId"), "message_id": msg_id}


def start_watch(creds, topic_name: str, label_ids=None) -> dict:
    """Register a Gmail push watch on the account's INBOX. Google will publish a
    notification to ``topic_name`` (a Cloud Pub/Sub topic,
    ``projects/<proj>/topics/<name>``) whenever the mailbox changes; a Pub/Sub
    push subscription then POSTs it to our webhook. Returns
    {"history_id": str, "expiration_ms": int}. Watches expire in ≤7 days and
    must be renewed. Requires the topic's publisher role granted to
    gmail-api-push@system.gserviceaccount.com (a one-time GCP setup)."""
    body = {"topicName": topic_name, "labelIds": label_ids or ["INBOX"],
            "labelFilterBehavior": "INCLUDE"}
    resp = _service(creds).users().watch(userId="me", body=body).execute()
    return {
        "history_id": str(resp.get("historyId") or ""),
        "expiration_ms": int(resp["expiration"]) if resp.get("expiration") else None,
    }


def stop_watch(creds) -> None:
    """Cancel the account's Gmail push watch (idempotent — Gmail 204s even when
    there's no active watch)."""
    _service(creds).users().stop(userId="me").execute()


def fetch_inbox_for_account(creds, max_results: int = 30, skip_automated: bool = True) -> list:
    """Fetch the most recent inbox messages for a connected account (full scan).

    `creds` is a live google.oauth2 Credentials (from
    integrations.google_accounts.account_credentials). Dedup against already
    threaded messages happens downstream on the Message-ID header, same as
    the IMAP path. Used for the first sync (no cursor yet) and as the fallback
    when an incremental cursor has expired.
    """
    service = _service(creds)
    listing = service.users().messages().list(
        userId="me", labelIds=["INBOX"], maxResults=max_results,
    ).execute()
    out = []
    for ref in listing.get("messages", []) or []:
        d = _message_dict(service, ref["id"], skip_automated=skip_automated)
        if d:
            out.append(d)
    return out


class HistoryExpired(Exception):
    """Gmail returned 404 for the stored startHistoryId — it's older than
    Gmail's history retention window (≈ 1 week), so an incremental sync isn't
    possible and the caller must fall back to a full scan + re-seed."""


def fetch_inbox_incremental(creds, start_history_id: str, skip_automated: bool = True) -> dict:
    """Incremental inbox sync via the Gmail History API — only messages ADDED
    to INBOX since ``start_history_id`` are fetched, instead of re-scanning the
    newest N every poll. Cheap and complete (no fixed message cap).

    Returns {"messages": [...], "new_history_id": str}. Raises HistoryExpired
    when the cursor is too old (HTTP 404) so the caller does a full re-sync.
    Uses the existing gmail.readonly scope — no new consent required.
    """
    from googleapiclient.errors import HttpError
    service = _service(creds)
    seen_ids, messages = set(), []
    latest_history_id = str(start_history_id or "")
    page_token = None
    try:
        while True:
            resp = service.users().history().list(
                userId="me", startHistoryId=start_history_id,
                historyTypes=["messageAdded"], labelId="INBOX",
                pageToken=page_token,
            ).execute()
            if resp.get("historyId"):
                latest_history_id = str(resp["historyId"])
            for h in resp.get("history", []) or []:
                for added in h.get("messagesAdded", []) or []:
                    mid = (added.get("message") or {}).get("id")
                    # INBOX label check: history can include messages already
                    # archived by the time we read them — only take current-INBOX.
                    labels = (added.get("message") or {}).get("labelIds") or []
                    if not mid or mid in seen_ids or "INBOX" not in labels:
                        continue
                    seen_ids.add(mid)
                    d = _message_dict(service, mid, skip_automated=skip_automated)
                    if d:
                        messages.append(d)
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
    except HttpError as e:
        if getattr(e, "resp", None) is not None and e.resp.status == 404:
            raise HistoryExpired(str(e))
        raise
    return {"messages": messages, "new_history_id": latest_history_id}
