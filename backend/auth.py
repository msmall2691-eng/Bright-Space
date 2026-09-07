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

# Paths that never require an API key or JWT.
# /api/config used to live here and served BRIGHTBASE_API_KEY to anyone
# unauthenticated (BB-SEC-01). The endpoint was removed; do not re-add.
# /ws/ is not listed because BaseHTTPMiddleware does not intercept
# WebSocket connections — auth for /ws/agent/* happens inside the handler.
_PUBLIC_PREFIXES = (
    "/api/health",
    # Public build identifier — same rationale as /api/health: needs to be
    # readable without a JWT so you can hit it after a deploy to confirm which
    # commit is actually running before signing in.
    "/api/version",
    "/api/auth/login",
    "/api/auth/register",
    # Newly-added staff/crew set their password from an emailed invite link
    # before any session exists; the handler validates a signed, typed,
    # short-lived invite token itself.
    "/api/auth/accept-invite",
    # Google SIGN-IN. Note the trailing slash, and note that it is load-bearing.
    #
    # This read "/api/auth/google" — a bare stem — and _is_public is a PREFIX
    # match, so it also opened /api/auth/google-account, its /connect-url and
    # anything else anyone ever names with that stem. Those are the signed-in
    # user's Google connection endpoints, and past the middleware
    # get_current_user hands a request with no Authorization header a
    # SYNTHETIC role="admin" user whenever BRIGHTBASE_API_KEY is set — so an
    # unauthenticated caller reached them as an admin.
    #
    # Exactly the hazard _PUBLIC_EXACT below was invented for, one family up.
    "/api/auth/google/",
    "/api/intake/submit",
    "/api/intake/webhook",
    "/api/comms/twilio/webhook",
    # Stripe Connect account events. Stripe can't send our API key, so the
    # handler verifies the webhook signature itself and REFUSES when
    # STRIPE_WEBHOOK_SECRET is unset — same posture as Twilio above. It is the
    # only writer of a sub's cached payout state, so an unsigned request here
    # would let a stranger mark anyone's payouts enabled.
    "/api/payroll/stripe/webhook",
    # Google Calendar push channel — authenticated by the per-channel token in
    # the handler (Google can't send our API key), not the master key.
    "/api/integrations/gcal/notifications",
    # Google OAuth redirect lands here without an API key; it's protected by a
    # one-time state nonce verified in the handler instead.
    "/api/settings/google/callback",
    "/api/booking",
    "/api/agents",
    "/api/quotes/public/",
    "/api/jobs/public/",
    # Per-cleaner iCal feeds: Google/Apple Calendar fetch these with no auth
    # headers — the unguessable per-user token in the path is the credential
    # (revocable by rotation). Read-only text/calendar bytes.
    "/api/crew-cal/",
    # Customer self-service portal — passwordless. request-link/verify are open
    # (rate-limited); the data endpoints enforce a portal-session token in the
    # portal router's own dependency, not the staff API key.
    "/api/portal/",
    # `/api/invoices/public/` was here for a customer-facing payment portal
    # that never worked and has been deleted rather than finished — see
    # modules/invoicing/router.py. There is no unauthenticated invoice
    # endpoint any more, so nothing needs the exemption, and leaving the
    # prefix open would exempt whatever somebody mounts under it next.
    # Company logo image — loaded unauthenticated by the quote email (<img>),
    # the PDF generator, and the public quote page. Read-only; serves bytes only.
    "/api/settings/logo",
    "/assets/",
)


# Paths that are public EXACTLY, with nothing beneath them.
#
# _PUBLIC_PREFIXES is a prefix match, which is right for a family like
# "/api/booking" but wrong for a single endpoint: listing "/api/apply" there
# would also open "/api/apply-status", "/api/applications" and anything else
# somebody later names with that stem — silently, with no test failing. The
# public apply form is one POST and should stay one POST.
_PUBLIC_EXACT = frozenset({
    # Google sign-in's own bare path — the login page POSTs here before a JWT
    # exists. EXACT, so it opens this endpoint and not the /google-account
    # family that shares its stem.
    "/api/auth/google",
    # The per-user Google CONNECT redirect, open for the same reason
    # /api/settings/google/callback is: Google sends the browser here with no
    # Bearer header and the handler resolves the user from a one-time,
    # 10-minute state nonce it then deletes. Listed EXACT rather than
    # reopening the stem the fix above just closed — gating this one silently
    # breaks connecting a Google account, and nothing fails until somebody
    # tries it.
    "/api/auth/google-account/callback",
    # Applying to join the bench (migration 102). Rate-limited, honeypotted and
    # length-capped in the handler; it can only ever write a `new` row to
    # sub_applications. It creates no login, reads nothing back, and never
    # reveals whether an email is already known — approval is an admin
    # clicking a button (modules/apply/router.py).
    "/api/apply",
})


def _is_public(path: str) -> bool:
    # Exact matches first — a stem that must not open its neighbours.
    if path.rstrip("/") in _PUBLIC_EXACT:
        return True
    if path.startswith(_PUBLIC_PREFIXES):
        return True
    # Let the SPA catch-all serve frontend routes
    if not path.startswith("/api/") and not path.startswith("/ws/"):
        return True
    return False


class APIKeyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # BB-SEC-16: the RAW ASGI path, not request.url.path.
        #
        # request.url is REBUILT from the Host header, and Starlette < 0.47.2
        # (we ship 0.38.6) does not validate that header before doing so
        # (CVE-2026-48710). A request line of `GET /api/clients` with
        # `Host: victim/abc?x=` reconstructs to `http://victim/abc?x=/api/clients`,
        # whose parsed `.path` is `/abc` — which `_is_public` waves through as a
        # non-/api/ SPA route, so this middleware skips auth entirely and the
        # real /api/clients handler runs unauthenticated. Verified: a poisoned
        # Host returns 200 and the client list where an honest one returns 401.
        #
        # `scope["path"]` is what the ROUTER dispatched on, so reading it here
        # makes the auth decision and the routing decision agree on one path —
        # which is the invariant the CVE is about. This closes the hole
        # independently of the Starlette version; the dependency bump (the rest
        # of the review's item) is still worth doing, but is not what stands
        # between this bypass and production.
        raw_path = request.scope.get("path") or request.url.path
        if _is_public(raw_path):
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
            # Fail CLOSED. This previously allowed EVERY request through when the
            # key was unset, so a misconfigured deploy served all data with no
            # auth. A valid JWT is already handled above, so logged-in traffic is
            # unaffected; only unauthenticated requests are rejected now. Ensure
            # BRIGHTBASE_API_KEY is set in production.
            logger.error("[auth] BRIGHTBASE_API_KEY not set and no valid JWT — rejecting request.")
            return JSONResponse(
                {"detail": "Server authentication is not configured."}, status_code=401
            )

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
