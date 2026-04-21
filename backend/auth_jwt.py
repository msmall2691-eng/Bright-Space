"""
Password hashing and JWT token management for authentication.
Uses bcrypt with 72-byte truncation (bcrypt's hard limit).
"""

import bcrypt
import jwt
import os
from datetime import datetime, timedelta
from typing import Optional

SECRET_KEY = os.getenv("JWT_SECRET", "change-me-in-production")
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
