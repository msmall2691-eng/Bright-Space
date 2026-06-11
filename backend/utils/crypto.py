"""Fernet encryption for secrets at rest (per-user Google OAuth tokens).

Key comes from the TOKEN_ENCRYPTION_KEY env var (generate once with
`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).
Losing/rotating the key is safe-but-annoying: stored tokens become
undecryptable and users simply reconnect their Google accounts.
"""
import os

from cryptography.fernet import Fernet, InvalidToken


class TokenEncryptionUnavailable(RuntimeError):
    """TOKEN_ENCRYPTION_KEY is missing or malformed — secrets can't be stored."""


def _fernet() -> Fernet:
    key = (os.getenv("TOKEN_ENCRYPTION_KEY") or "").strip()
    if not key:
        raise TokenEncryptionUnavailable(
            "TOKEN_ENCRYPTION_KEY is not set. Generate one with "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" "
            "and add it to the server environment."
        )
    try:
        return Fernet(key.encode())
    except Exception as e:
        raise TokenEncryptionUnavailable(f"TOKEN_ENCRYPTION_KEY is malformed: {e}")


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
