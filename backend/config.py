"""Environment and configuration utilities."""

import logging
import os

logger = logging.getLogger(__name__)

# Safe fallback for the customer-facing base URL. Points at the app's own
# Railway host — NOT bright-space.com, which is an unrelated live company. If
# APP_BASE_URL is ever dropped, quote links degrade to the real app instead of
# silently pointing customers at someone else's website.
DEFAULT_APP_BASE_URL = "https://brightbase-production.up.railway.app"

# Neutral last-resort sender. The real from-address comes from SMTP creds /
# Settings; this only applies if none is configured, and must not impersonate
# the unrelated bright-space.com domain.
DEFAULT_FROM_EMAIL = "no-reply@brightbase.app"


def app_base_url() -> str:
    """Customer-facing base URL for public quote links (no trailing slash).

    Single source of truth so the 4 call sites can't drift to different
    defaults. Logs a warning when APP_BASE_URL is unset so a missing env var
    is loud rather than silently shipping the fallback to customers."""
    raw = (os.getenv("APP_BASE_URL") or "").strip()
    if not raw:
        logger.warning(
            "APP_BASE_URL is not set; falling back to %s. Set it in the "
            "environment so quote links point at the right host.",
            DEFAULT_APP_BASE_URL,
        )
        return DEFAULT_APP_BASE_URL
    return raw.rstrip("/")


# Origins the lead pipeline depends on — the maineclean.co contact form posts
# leads cross-origin to /api/intake/submit. A partial ALLOWED_ORIGINS override in
# the environment that drops these silently breaks CORS preflight, so the browser
# blocks the POST and inbound leads are lost (live-run #2 incident, 2026-06-14).
# These are force-merged into the allow-list so a misconfigured env can't kill it.
REQUIRED_CORS_ORIGINS = ("https://www.maineclean.co", "https://maineclean.co")

DEFAULT_CORS_ORIGINS = (
    "http://localhost:5173,http://localhost:3000,"
    "https://www.maineclean.co,https://maineclean.co,"
    "https://brightbase-production.up.railway.app"
)


def resolve_cors_origins(raw: str | None) -> list[str]:
    """Allowed CORS origins = the configured list UNION the required production
    origins (deduped, order-stable). Guarantees the website's lead form keeps
    working even if ALLOWED_ORIGINS is set but omits it; warns when it had to
    re-add them so the misconfig is visible."""
    source = raw if (raw and raw.strip()) else DEFAULT_CORS_ORIGINS
    configured = [o.strip() for o in source.split(",") if o.strip()]
    missing = [o for o in REQUIRED_CORS_ORIGINS if o not in configured]
    if missing:
        logger.warning(
            "ALLOWED_ORIGINS did not include %s — re-added so the website lead "
            "form keeps working. Update the ALLOWED_ORIGINS env to include them.",
            missing,
        )
    return list(dict.fromkeys(configured + list(REQUIRED_CORS_ORIGINS)))


def env_flag(name: str, default: bool = True) -> bool:
    """Parse environment boolean flag."""
    val = os.getenv(name, str(default)).lower()
    return val in ("true", "1", "yes", "on")


def env_int(name: str, default: int) -> int:
    """Parse environment integer with fallback to default on error."""
    try:
        return int(os.getenv(name, default))
    except (ValueError, TypeError):
        return default
