"""
Password hashing and JWT token management for authentication.
Uses bcrypt with 72-byte truncation (bcrypt's hard limit).
"""

import bcrypt
import jwt
import logging
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

# BB-SEC-03: previously defaulted to the literal "change-me-in-production",
# which silently signed JWTs with a public, attacker-known value any time
# JWT_SECRET wasn't set (new deploys, preview environments, forgotten staging
# branches). With that value, an attacker could forge tokens for any user_id
# and role, including role="admin".
#
# Now: if JWT_SECRET isn't set we mint a random per-process secret. Tokens
# signed with it become invalid on every restart, which is correct for an
# unconfigured environment — it nudges the operator to set JWT_SECRET if
# they want stable sessions, and the public default literal never escapes.
_env_secret = os.getenv("JWT_SECRET", "").strip()
if _env_secret:
    SECRET_KEY = _env_secret
else:
    SECRET_KEY = secrets.token_urlsafe(48)
    logger.critical(
        "[auth_jwt] JWT_SECRET is not set. Generated a random per-process "
        "secret; all JWT sessions will be invalidated on every restart. "
        "Set JWT_SECRET in the environment for stable sessions."
    )

ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24


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


def create_jwt(user_id: int, email: str, role: str) -> str:
    """Create a JWT token with user info and 24-hour expiration."""
    expires = datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS)
    payload = {
        "user_id": user_id,
        "email": email,
        "role": role,
        "exp": expires,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_jwt(token: str) -> Optional[dict]:
    """Decode and verify a JWT token. Returns payload if valid, None if invalid."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None
