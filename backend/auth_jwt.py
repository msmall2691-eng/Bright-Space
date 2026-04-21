"""
Password hashing and verification for JWT authentication.
Uses bcrypt with 72-byte truncation (bcrypt's hard limit).
"""

import bcrypt


def hash_password(plain: str) -> str:
    """Hash a plaintext password using bcrypt with 72-byte truncation."""
    password_bytes = plain.encode('utf-8')[:72]
    password_hash = bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode('utf-8')
    return password_hash


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash with 72-byte truncation."""
    try:
        password_bytes = plain.encode('utf-8')[:72]
        hashed_bytes = hashed.encode('utf-8')
        return bcrypt.checkpw(password_bytes, hashed_bytes)
    except Exception:
        return False
