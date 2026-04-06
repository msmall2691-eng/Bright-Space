"""
API-key authentication middleware for BrightBase.

Every request must include a valid key via the X-API-Key header
or an `api_key` query parameter (used by WebSocket connections).

Public paths (health check, intake form, Twilio webhook, etc.)
are exempted so external integrations keep working.
"""

import os
import secrets
import logging

from fastapi import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

logger = logging.getLogger(__name__)

# Paths that never require an API key
_PUBLIC_PREFIXES = (
    "/api/health",
    "/api/intake/submit",
    "/api/comms/twilio/webhook",
    "/api/booking",
    "/api/agents",
    "/ws/",
    "/assets/",
)


def _is_public(path: str) -> bool:
    if path.startswith(_PUBLIC_PREFIXES):
        return True
    # Let the SPA catch-all serve frontend routes
    if not path.startswith("/api/") and not path.startswith("/ws/"):
        return True
    return False


class APIKeyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if _is_public(request.url.path):
            return await call_next(request)

        expected_key = os.getenv("BRIGHTBASE_API_KEY", "")
        if not expected_key:
            logger.warning("[auth] BRIGHTBASE_API_KEY not set — all requests allowed.")
            return await call_next(request)

        # Accept key from header or query param (WebSocket)
        provided_key = request.headers.get("X-API-Key", "")
        if not provided_key:
            provided_key = request.query_params.get("api_key", "")

        if not provided_key:
            raise HTTPException(status_code=401, detail="Missing API key.")
        if not secrets.compare_digest(provided_key, expected_key):
            raise HTTPException(status_code=403, detail="Invalid API key.")

        return await call_next(request)
