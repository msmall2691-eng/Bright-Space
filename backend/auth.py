"""
API-key and JWT authentication middleware for BrightBase.

Requests can authenticate via:
1. JWT token in Authorization header (Bearer <token>)
2. X-API-Key header
3. api_key query parameter (WebSocket)

Public paths (health check, intake form, Twilio webhook, etc.)
are exempted so external integrations keep working.
"""

import os
import secrets
import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from auth_jwt import verify_jwt

logger = logging.getLogger(__name__)

# Paths that never require an API key or JWT
_PUBLIC_PREFIXES = (
    "/api/health",
    "/api/config",
    "/api/auth/login",
    "/api/auth/register",
    "/api/intake/submit",
    "/api/intake/webhook",
    "/api/comms/twilio/webhook",
    "/api/booking",
    "/api/agents",
    "/api/quotes/public/",
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

        # Try JWT first (Authorization: Bearer <token>)
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]  # Remove "Bearer " prefix
            payload = verify_jwt(token)
            if payload:
                # Valid JWT — attach user info to request state for dependency injection
                request.state.current_user_id = payload.get("user_id")
                request.state.current_user_email = payload.get("email")
                request.state.current_user_role = payload.get("role")
                return await call_next(request)
            else:
                return JSONResponse(
                    {"detail": "Invalid or expired token."}, status_code=401
                )

        # Fall back to API key
        expected_key = os.getenv("BRIGHTBASE_API_KEY", "")
        if not expected_key:
            logger.warning("[auth] BRIGHTBASE_API_KEY not set — all requests allowed.")
            return await call_next(request)

        # Accept key from header or query param (WebSocket)
        provided_key = request.headers.get("X-API-Key", "")
        if not provided_key:
            provided_key = request.query_params.get("api_key", "")

        # NOTE: we return JSONResponse directly instead of raising HTTPException.
        # Starlette's BaseHTTPMiddleware.dispatch() runs BELOW FastAPI's
        # exception handlers, so a raised HTTPException propagates up as an
        # unhandled exception and Starlette serves it as a generic 500 —
        # not the 401/403 the caller expected. Returning a JSONResponse
        # bypasses that trap.
        if not provided_key:
            return JSONResponse(
                {"detail": "Missing API key or JWT token."}, status_code=401
            )
        if not secrets.compare_digest(provided_key, expected_key):
            return JSONResponse(
                {"detail": "Invalid API key."}, status_code=403
            )

        return await call_next(request)
