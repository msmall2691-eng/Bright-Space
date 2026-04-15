"""
Gmail inbox sync integration.
Pulls new emails from your Gmail account, creates leads/contacts, and groups them into conversations.

Works like Zapier/Make: automatically pulls new messages from INBOX, matches them to existing
clients by email address, and creates LeadIntake for new senders.
"""

import os
import base64
import logging
from pathlib import Path
from datetime import datetime
from email.mime.text import MIMEText

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from sqlalchemy.orm import Session

from database.models import Message, Conversation, Client, LeadIntake

logger = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",  # Read emails
    "https://www.googleapis.com/auth/calendar",        # Calendar sync
]


def _get_gmail_service():
    """Build and return an authenticated Gmail service."""
    base = Path(__file__).parent.parent
    token_path = base / os.getenv("GOOGLE_TOKEN_FILE", "google_token.json")

    # Support base64-encoded credentials stored in env vars (for Railway/cloud)
    token_b64 = os.getenv("GOOGLE_TOKEN_B64")
    if token_b64 and not token_path.exists():
        token_path.write_bytes(base64.b64decode(token_b64))

    creds_b64 = os.getenv("GOOGLE_CREDENTIALS_B64")
    creds_path = base / os.getenv("GOOGLE_CREDENTIALS_FILE", "google_credentials.json")
    if creds_b64 and not creds_path.exists():
        creds_path.write_bytes(base64.b64decode(creds_b64))

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not creds_path.exists():
                raise FileNotFoundError(
                    f"Google credentials not found at {creds_path}. "
                    "Run auth_google.py to authorize Gmail access."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), SCOPES)
            creds = flow.run_local_server(port=0)

        token_path.write_text(creds.to_json())

    return build("gmail", "v1", credentials=creds)


def _extract_email(email_str: str) -> str:
    """Extract email address from 'Name <email@domain>' format."""
    if "<" in email_str and ">" in email_str:
        return email_str.split("<")[1].split(">")[0].strip()
    return email_str.strip()


def _extract_name_from_email(email_str: str) -> str:
    """Extract sender name from email."""
    if "<" in email_str:
        return email_str.split("<")[0].strip() or email_str.split("@")[0]
    return email_str.split("@")[0]


def _match_client_by_email(db: Session, email_addr: str) -> Client | None:
    """Find existing client by email address."""
    if not email_addr:
        return None
    normalized = email_addr.lower().strip()
    client = db.query(Client).filter(Client.email == normalized).first()
    return client


def sync_gmail_inbox(db: Session) -> dict:
    """
    Sync new emails from Gmail inbox.

    Returns stats: {
        "emails_checked": N,
        "new_emails": N,
        "leads_created": N,
        "messages_stored": N,
        "error": None or error message
    }
    """
    stats = {
        "emails_checked": 0,
        "new_emails": 0,
        "leads_created": 0,
        "messages_stored": 0,
        "error": None,
    }

    try:
        service = _get_gmail_service()
    except Exception as e:
        stats["error"] = f"Failed to authenticate Gmail: {str(e)}"
        logger.error(stats["error"])
        return stats

    try:
        # Query for unread messages in INBOX
        results = service.users().messages().list(
            userId="me",
            q="is:unread in:INBOX",
            maxResults=10,  # Limit to last 10 unread to avoid spam
        ).execute()

        messages = results.get("messages", [])
        stats["emails_checked"] = len(messages)

        if not messages:
            logger.info("[gmail_sync] No new unread emails")
            return stats

        logger.info(f"[gmail_sync] Found {len(messages)} unread emails")

        for msg_data in messages:
            msg_id = msg_data["id"]

            # Check if we've already ingested this message
            existing = db.query(Message).filter(Message.external_id == msg_id).first()
            if existing:
                logger.debug(f"[gmail_sync] Message {msg_id} already ingested, skipping")
                continue

            # Fetch full message
            try:
                full_msg = service.users().messages().get(userId="me", id=msg_id).execute()
            except HttpError as e:
                logger.warning(f"[gmail_sync] Failed to fetch message {msg_id}: {e}")
                continue

            headers = {h["name"]: h["value"] for h in full_msg.get("payload", {}).get("headers", [])}
            from_addr = headers.get("From", "")
            subject = headers.get("Subject", "(no subject)")
            sender_email = _extract_email(from_addr)
            sender_name = _extract_name_from_email(from_addr)

            # Extract body
            body_text = ""
            if "parts" in full_msg.get("payload", {}):
                for part in full_msg["payload"]["parts"]:
                    if part["mimeType"] == "text/plain":
                        data = part.get("body", {}).get("data", "")
                        if data:
                            body_text = base64.urlsafe_b64decode(data).decode("utf-8")
                        break
            else:
                data = full_msg.get("payload", {}).get("body", {}).get("data", "")
                if data:
                    body_text = base64.urlsafe_b64decode(data).decode("utf-8")

            # Internal timestamp
            internal_date_ms = int(full_msg.get("internalDate", 0))
            msg_datetime = datetime.fromtimestamp(internal_date_ms / 1000) if internal_date_ms else datetime.utcnow()

            stats["new_emails"] += 1

            # Match to existing client by email
            client = _match_client_by_email(db, sender_email)

            if not client:
                # Create new client + lead intake for new senders
                logger.info(f"[gmail_sync] New sender {sender_email} — creating client + lead")
                client = Client(
                    name=sender_name,
                    email=sender_email,
                    status="lead",
                    source="email",
                )
                db.add(client)
                db.flush()

                intake = LeadIntake(
                    name=sender_name,
                    email=sender_email,
                    message=f"Subject: {subject}\n\n{body_text[:500]}",  # First 500 chars
                    source="email",
                    status="new",
                    client_id=client.id,
                )
                db.add(intake)
                stats["leads_created"] += 1
            else:
                logger.info(f"[gmail_sync] Linked to existing client #{client.id} ({client.name})")

            # Create conversation for this email thread
            conv = find_or_create_conversation(
                db,
                channel="email",
                client_id=client.id,
                external_contact=sender_email,
                subject=subject,
            )

            # Store message
            msg = Message(
                client_id=client.id,
                conversation_id=conv.id,
                channel="email",
                direction="inbound",
                from_addr=sender_email,
                to_addr=headers.get("To", ""),
                subject=subject,
                body=body_text,
                status="received",
                external_id=msg_id,
                created_at=msg_datetime,
            )
            db.add(msg)
            stats["messages_stored"] += 1

            # Mark as read in Gmail (optional — prevents re-syncing)
            try:
                service.users().messages().modify(
                    userId="me",
                    id=msg_id,
                    body={"removeLabelIds": ["UNREAD"]},
                ).execute()
                logger.debug(f"[gmail_sync] Marked message {msg_id} as read in Gmail")
            except HttpError as e:
                logger.warning(f"[gmail_sync] Failed to mark {msg_id} as read: {e}")

        db.commit()
        logger.info(f"[gmail_sync] Sync complete: {stats['new_emails']} emails, {stats['leads_created']} new leads")

    except Exception as e:
        stats["error"] = str(e)
        logger.error(f"[gmail_sync] Sync failed: {e}")
        db.rollback()

    return stats


def find_or_create_conversation(
    db: Session,
    channel: str,
    client_id: int,
    external_contact: str = None,
    subject: str = None,
) -> Conversation:
    """Find existing conversation or create a new one."""
    # For email, group by sender + subject to avoid creating duplicate threads
    if channel == "email":
        conv = db.query(Conversation).filter(
            Conversation.channel == channel,
            Conversation.client_id == client_id,
        ).first()
    else:
        conv = db.query(Conversation).filter(
            Conversation.channel == channel,
            Conversation.client_id == client_id,
            Conversation.external_contact == external_contact,
        ).first()

    if not conv:
        conv = Conversation(
            channel=channel,
            client_id=client_id,
            external_contact=external_contact,
            subject=subject,
            status="open",
            priority="normal",
        )
        db.add(conv)
        db.flush()

    return conv
