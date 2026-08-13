"""
Password hashing and JWT token management for authentication.
Uses bcrypt with 72-byte truncation (bcrypt's hard limit).
"""

import bcrypt
import jwt
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

# BB-SEC-03: previously defaulted to the literal "change-me-in-production",
# which silently signed JWTs with a public, attacker-known value any time
# JWT_SECRET wasn't set (new deploys, preview environments, forgotten staging
# branches). With that value, an attacker could forge tokens for any user_id
# and role, including role="admin".
#
# A later fix minted a random per-process secret instead of the public
# literal — better, but wrong in a different way once the deploy runs
# multiple uvicorn workers (railway.json's --workers 4): this module is
# imported independently in EACH worker process, so each one would mint its
# OWN random secret. A token signed by the worker that handled login fails
# to verify on whichever worker handles the next request, showing up as
# random, intermittent logouts. There's no way to make "unset" both safe
# and stable across workers, so this is a hard failure instead — the
# environment must set JWT_SECRET before the app can start at all.
_env_secret = os.getenv("JWT_SECRET", "").strip()
if not _env_secret:
    raise RuntimeError(
        "JWT_SECRET is not set. Refusing to start: a random per-process "
        "secret would sign tokens that only verify on whichever worker "
        "process issued them, causing random logouts under Railway's "
        "multi-worker deploy. Set JWT_SECRET in the environment "
        "(e.g. `openssl rand -base64 48`) and redeploy."
    )
SECRET_KEY = _env_secret

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


def make_invite_token(email: str, ttl_days: int = 7) -> str:
    """Short-lived, single-purpose token emailed to a newly-added staff/crew
    member so they set their own password. Carries typ='staff_invite' and NO
    user_id, so it can never satisfy get_current_user on its own (mirrors the
    customer-portal magic-token isolation)."""
    payload = {
        "email": (email or "").strip().lower(),
        "typ": "staff_invite",
        "exp": datetime.now(timezone.utc) + timedelta(days=ttl_days),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def read_invite_token(token: str) -> Optional[str]:
    """Return the email a valid staff-invite token carries, else None."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None
    if payload.get("typ") != "staff_invite":
        return None
    return ((payload.get("email") or "").strip().lower()) or None


def create_jwt(user_id: int, email: str, role: str) -> str:
    """Create a JWT token with user info and 24-hour expiration."""
    expires = datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRE_HOURS)
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


def maybe_refresh_jwt(token: str) -> Optional[str]:
    """Sliding-session refresh: if ``token`` is still valid but has passed the
    halfway point of its lifetime, return a freshly-minted token (same claims,
    new 24h expiry); otherwise return None.

    The HTTP middleware calls this on every authenticated request and, when a
    new token comes back, hands it to the client via the X-Refresh-Token response
    header. The effect: an actively-working user never gets logged out mid-task
    (e.g. mid-booking), while a truly idle session still expires on schedule.
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None
    exp = payload.get("exp")
    if not exp:
        return None
    remaining = exp - datetime.now(timezone.utc).timestamp()
    # Only refresh a live token that's past its half-life — never an expired one.
    if 0 < remaining < (TOKEN_EXPIRE_HOURS * 3600) / 2:
        return create_jwt(payload.get("user_id"), payload.get("email", ""), payload.get("role", "member"))
    return None
