"""Per-user Google account credentials (phase B/C of
docs/auth-workspaces-plan-2026-06.md).

Each user_google_accounts row holds a member's own OAuth grant with tokens
Fernet-encrypted at rest. This module turns a row into live, auto-refreshing
google.oauth2 Credentials and persists rotated tokens back (re-encrypted).

A refresh failure (revoked at Google, key rotated, …) marks the row
status='expired' with last_sync_error set, so Settings can show "reconnect
your Google account" instead of sync dying silently.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from database.models import UserGoogleAccount
from utils.crypto import decrypt_secret, encrypt_secret, InvalidToken, TokenEncryptionUnavailable

logger = logging.getLogger(__name__)

TOKEN_URI = "https://oauth2.googleapis.com/token"


class AccountCredentialsError(RuntimeError):
    """This account's grant can't be used — the user must reconnect."""


def account_credentials(db: Session, account: UserGoogleAccount):
    """Live Credentials for a connected account, refreshing if expired.

    Raises AccountCredentialsError after marking the row expired when the
    grant is unusable (missing refresh token, decryption failure, refresh
    rejected by Google).
    """
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    from integrations.google_oauth import client_id, client_secret

    def _fail(reason: str):
        account.status = "expired"
        account.last_sync_error = reason
        db.commit()
        raise AccountCredentialsError(f"{account.email}: {reason}")

    try:
        refresh_token = decrypt_secret(account.refresh_token or "")
        access_token = decrypt_secret(account.access_token or "")
    except (InvalidToken, TokenEncryptionUnavailable) as e:
        _fail(f"stored tokens unreadable ({e.__class__.__name__}) — reconnect Google")

    if not refresh_token:
        _fail("no refresh token on file — reconnect Google")

    creds = Credentials(
        token=access_token or None,
        refresh_token=refresh_token,
        token_uri=TOKEN_URI,
        client_id=client_id(),
        client_secret=client_secret(),
        scopes=list(account.scopes or []),
    )
    expiry = account.token_expiry
    if expiry is not None:
        # google-auth compares against naive-UTC datetimes.
        creds.expiry = expiry.replace(tzinfo=None) if expiry.tzinfo else expiry

    if not creds.valid:
        try:
            creds.refresh(Request())
        except Exception as e:
            _fail(f"token refresh failed: {e}")
        # Persist the rotated access token (encrypted) so the next tick
        # doesn't have to refresh again.
        try:
            account.access_token = encrypt_secret(creds.token or "")
            account.token_expiry = creds.expiry
            account.status = "connected"
            account.last_sync_error = None
            db.commit()
        except Exception as e:
            logger.warning(f"[google-accounts] could not persist refreshed token for {account.email}: {e}")
            db.rollback()

    return creds


def calendar_account(db: Session) -> Optional[UserGoogleAccount]:
    """The connected account that should drive calendar sync (v1: the most
    recently connected one with the calendar channel enabled)."""
    return (
        db.query(UserGoogleAccount)
        .filter(UserGoogleAccount.gcal_sync_enabled == True,  # noqa: E712
                UserGoogleAccount.status == "connected")
        .order_by(UserGoogleAccount.connected_at.desc())
        .first()
    )


def gmail_accounts(db: Session) -> list:
    """Every connected account with the Gmail channel enabled."""
    return (
        db.query(UserGoogleAccount)
        .filter(UserGoogleAccount.gmail_sync_enabled == True,  # noqa: E712
                UserGoogleAccount.status == "connected")
        .order_by(UserGoogleAccount.connected_at.asc())
        .all()
    )


def mark_sync(db: Session, account: UserGoogleAccount, error: Optional[str] = None):
    account.last_sync_at = datetime.now(timezone.utc)
    account.last_sync_error = error
    db.commit()
