"""Tests for sliding-session token refresh (auth_jwt.maybe_refresh_jwt).

The middleware uses this to rotate a token once it passes its half-life, so an
active user is never logged out mid-task. Rules:
- a fresh token (lots of life left) is NOT refreshed
- a token past its half-life IS refreshed (same claims, new expiry)
- an expired or garbage token is NOT refreshed
"""
import jwt
from datetime import datetime, timedelta, timezone

import auth_jwt
from auth_jwt import maybe_refresh_jwt, SECRET_KEY, ALGORITHM, TOKEN_EXPIRE_HOURS


def _token(hours_until_exp):
    payload = {
        "user_id": 42, "email": "a@b.co", "role": "manager",
        "exp": datetime.now(timezone.utc) + timedelta(hours=hours_until_exp),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def test_fresh_token_not_refreshed():
    # ~full lifetime remaining → no rotation
    assert maybe_refresh_jwt(_token(TOKEN_EXPIRE_HOURS - 0.1)) is None


def test_past_halflife_is_refreshed():
    out = maybe_refresh_jwt(_token(1))  # only 1h left of a 24h token
    assert isinstance(out, str)
    decoded = jwt.decode(out, SECRET_KEY, algorithms=[ALGORITHM])
    assert decoded["user_id"] == 42 and decoded["role"] == "manager"
    # New token carries a later expiry than the near-dead input.
    assert decoded["exp"] > (datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRE_HOURS - 1)).timestamp()


def test_expired_token_not_refreshed():
    assert maybe_refresh_jwt(_token(-1)) is None


def test_garbage_token_not_refreshed():
    assert maybe_refresh_jwt("not-a-jwt") is None
