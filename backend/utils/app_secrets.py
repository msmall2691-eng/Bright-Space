"""Encryption-at-rest for sensitive ``app_settings`` values.

``app_settings`` stores integration credentials — the SMTP password, the Square
access token, the Connecteam API key, and the shared Google OAuth token. These
were historically stored in PLAINTEXT, while per-user Google tokens
(``user_google_accounts``) were already Fernet-encrypted. That inconsistency
meant a DB dump or backup leaked live credentials. These helpers close the gap.

Design (rollout-safe):
  * ``encode_setting_value`` — encrypt a sensitive key's value before storage.
  * ``decode_setting_value`` — decrypt on read, **backward-compatible**: a value
    that isn't valid ciphertext (a legacy plaintext row, or an unrecoverable
    value after a key change) is returned unchanged, so nothing breaks while
    plaintext and encrypted rows coexist during rollout.
  * ``encrypt_existing_secrets`` — idempotent one-time backfill of legacy
    plaintext rows (run pre-deploy, single process, no worker race).

Only keys in ``SECRET_SETTING_KEYS`` are touched; every other setting passes
through untouched. Encryption uses the shared Fernet key (``utils.crypto``),
derived from ``JWT_SECRET``, so it's available whenever the app can boot.
"""
from __future__ import annotations

import logging

from utils.crypto import (
    encrypt_secret, decrypt_secret, encryption_available,
    InvalidToken, TokenEncryptionUnavailable,
)

logger = logging.getLogger(__name__)

# ``app_settings`` keys holding credentials that must be encrypted at rest.
# Exact match (not a regex) so we only ever encrypt values whose every read
# site has been routed through ``decode_setting_value`` (get_setting,
# _load_smtp_creds, gmail_inbox, google_calendar).
SECRET_SETTING_KEYS = {
    "smtp_pass",
    "imap_pass",
    "connecteam_api_key",
    "square_access_token",
    "google_token",
}


def _is_encrypted(value: str) -> bool:
    """True if ``value`` is a Fernet token we can currently decrypt."""
    if not value:
        return False
    try:
        decrypt_secret(value)
        return True
    except (InvalidToken, TokenEncryptionUnavailable):
        return False


def encode_setting_value(key: str, value):
    """Encrypt a sensitive setting for storage; pass non-secrets through.

    Never double-encrypts, and degrades to plaintext if encryption is somehow
    unavailable (``JWT_SECRET`` is required to boot, so that path is effectively
    unreachable in production)."""
    if not value or key not in SECRET_SETTING_KEYS:
        return value
    if not encryption_available():
        logger.warning("encryption unavailable — storing %s in plaintext", key)
        return value
    if _is_encrypted(value):
        return value
    return encrypt_secret(value)


def decode_setting_value(key: str, stored):
    """Decrypt a sensitive setting on read.

    Backward-compatible: a legacy plaintext value (or one we can't decrypt after
    a key change) is returned unchanged rather than raising, so a half-migrated
    table keeps working."""
    if not stored or key not in SECRET_SETTING_KEYS:
        return stored
    try:
        return decrypt_secret(stored)
    except (InvalidToken, TokenEncryptionUnavailable):
        return stored


def encrypt_existing_secrets(db) -> int:
    """One-time, idempotent backfill: encrypt any still-plaintext secret values
    in ``app_settings``. Safe to run repeatedly (already-encrypted rows are
    skipped) and intended to run pre-deploy (single process — no worker race).
    Returns the number of rows encrypted."""
    from database.models import AppSetting
    if not encryption_available():
        return 0
    n = 0
    rows = db.query(AppSetting).filter(AppSetting.key.in_(SECRET_SETTING_KEYS)).all()
    for r in rows:
        if r.value and not _is_encrypted(r.value):
            r.value = encrypt_secret(r.value)
            n += 1
    if n:
        db.commit()
        logger.info("encrypted %d legacy plaintext secret(s) at rest", n)
    return n
