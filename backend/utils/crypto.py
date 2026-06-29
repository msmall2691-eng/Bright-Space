"""Fernet encryption for secrets at rest (per-user Google OAuth tokens).

The key is resolved in this order, so the common case needs ZERO extra config:
  1. TOKEN_ENCRYPTION_KEY env var, if set (a dedicated Fernet key — best if you
     want the token key separated from everything else). Generate one with
     `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
  2. Otherwise, a key DERIVED from JWT_SECRET (which must already be set and
     stable for logins to persist). Domain-separated SHA-256, so it's a distinct
     key from the one that signs sessions — it just avoids a second secret to
     manage. This is what lets an admin connect Google with no setup step.

Both are server-side secrets of equal sensitivity and the key is never stored
in the database. Losing/rotating whichever secret is in play is safe-but-
annoying: stored tokens become undecryptable and users simply reconnect Google.
"""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken


class TokenEncryptionUnavailable(RuntimeError):
    """No usable key (no TOKEN_ENCRYPTION_KEY and no JWT_SECRET) — or it's
    malformed — so secrets can't be stored."""


def _derived_key_from_jwt() -> bytes | None:
    """A stable Fernet key derived from JWT_SECRET, or None when it isn't set.

    Reads JWT_SECRET directly (not the per-process random fallback in auth_jwt)
    so encryption only auto-enables when there's a STABLE secret to derive from —
    never a volatile one that would make tokens undecryptable after a restart."""
    secret = (os.getenv("JWT_SECRET") or "").strip()
    if not secret:
        return None
    digest = hashlib.sha256(("brightbase-token-encryption-v1:" + secret).encode()).digest()
    return base64.urlsafe_b64encode(digest)  # 32 bytes -> valid Fernet key


def _fernet() -> Fernet:
    explicit = (os.getenv("TOKEN_ENCRYPTION_KEY") or "").strip()
    if explicit:
        try:
            return Fernet(explicit.encode())
        except Exception as e:
            raise TokenEncryptionUnavailable(f"TOKEN_ENCRYPTION_KEY is malformed: {e}")
    derived = _derived_key_from_jwt()
    if derived:
        return Fernet(derived)
    raise TokenEncryptionUnavailable(
        "No encryption key available. Set JWT_SECRET (recommended — it's already "
        "needed for stable logins) or a dedicated TOKEN_ENCRYPTION_KEY."
    )


def encryption_available() -> bool:
    try:
        _fernet()
        return True
    except TokenEncryptionUnavailable:
        return False


def encrypt_secret(plaintext: str) -> str:
    """Encrypt a secret for storage. Empty/None passes through as ''. """
    if not plaintext:
        return ""
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(token: str) -> str:
    """Decrypt a stored secret. Raises InvalidToken if the key changed —
    callers should treat that as 'reconnect required', not a crash."""
    if not token:
        return ""
    return _fernet().decrypt(token.encode()).decode()


__all__ = ["encrypt_secret", "decrypt_secret", "encryption_available",
           "TokenEncryptionUnavailable", "InvalidToken"]
