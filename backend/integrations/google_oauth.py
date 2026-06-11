"""Self-serve Google OAuth (web flow).

Lets an admin connect their work Google account from inside the app — one click
in Settings → Integrations instead of running auth_google.py locally and pasting
a base64 token into Railway.

The resulting token is persisted in the app_settings table (key ``google_token``)
so it survives Railway's ephemeral filesystem. ``google_calendar._get_service``
reads it from there first.

Requires a Google Cloud "Web application" OAuth client whose authorized redirect
URI matches this server's ``/api/settings/google/callback``. Provide it via
``GOOGLE_CREDENTIALS_B64`` (base64 of the downloaded client-secret JSON) or via
``GOOGLE_CLIENT_ID`` / ``GOOGLE_CLIENT_SECRET``.
"""

import os
import json
import base64
from pathlib import Path

# Google reorders/expands scopes (adds 'openid'), which oauthlib treats as a
# scope-change error on token exchange. Relaxing avoids spurious failures when
# the login flow requests openid + calendar together.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

from google_auth_oauthlib.flow import Flow

# Calendar is the source of truth for scheduling. (Gmail stays on IMAP.)
SCOPES = ["https://www.googleapis.com/auth/calendar"]

# "Sign in with Google" is identity-ONLY. It used to also request calendar and
# silently capture a shared calendar token on every login — per-account access
# is now an explicit, separate "Connect Google account" consent (below).
LOGIN_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]

# Per-user "Connect Google account" (Settings): the member grants THEIR
# Gmail + Calendar to BrightBase; tokens are stored encrypted on
# user_google_accounts, never in a shared AppSetting.
CONNECT_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
]


def _client_config() -> dict | None:
    """Resolve the OAuth client config from env or a local file. Returns a dict
    shaped like Google's client-secret JSON ({"web": {...}}), or None."""
    raw = os.getenv("GOOGLE_CREDENTIALS_B64")
    if raw:
        try:
            return json.loads(base64.b64decode(raw))
        except Exception:
            pass

    cid = os.getenv("GOOGLE_CLIENT_ID")
    csec = os.getenv("GOOGLE_CLIENT_SECRET")
    if cid and csec:
        return {
            "web": {
                "client_id": cid,
                "client_secret": csec,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        }

    base = Path(__file__).parent.parent
    p = base / os.getenv("GOOGLE_CREDENTIALS_FILE", "google_credentials.json")
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return None


def client_id() -> str | None:
    """The OAuth client id — needed to verify Google ID tokens (sign-in) and to
    hand to the frontend's Google Identity Services button."""
    cid = os.getenv("GOOGLE_CLIENT_ID")
    if cid:
        return cid.strip()
    cfg = _client_config()
    if cfg:
        for key in ("web", "installed"):
            if isinstance(cfg.get(key), dict) and cfg[key].get("client_id"):
                return cfg[key]["client_id"]
    return None


def is_oauth_available() -> bool:
    """True when the server has an OAuth client configured, so the in-app
    'Connect Google' button can work."""
    return _client_config() is not None


def redirect_uri(request) -> str:
    """The OAuth redirect URI. Prefer an explicit env value (must match the
    Google Cloud console exactly); otherwise derive it from the request and
    force https, since Railway terminates TLS at the proxy."""
    env = os.getenv("GOOGLE_OAUTH_REDIRECT_URI")
    if env:
        return env
    base = str(request.base_url).rstrip("/")
    if base.startswith("http://") and not ("localhost" in base or "127.0.0.1" in base):
        base = "https://" + base[len("http://"):]
    return f"{base}/api/settings/google/callback"


def build_flow(request, state: str | None = None) -> Flow:
    cfg = _client_config()
    if not cfg:
        raise RuntimeError(
            "No Google OAuth client configured. Set GOOGLE_CREDENTIALS_B64 "
            "(a Web OAuth client) on the server."
        )
    return Flow.from_client_config(cfg, scopes=SCOPES, redirect_uri=redirect_uri(request), state=state)


def login_redirect_uri(request) -> str:
    """Redirect URI for the unified Sign-in-with-Google flow. Must be registered
    in the Google Cloud OAuth client. Prefer an explicit env value."""
    env = os.getenv("GOOGLE_LOGIN_REDIRECT_URI")
    if env:
        return env
    base = str(request.base_url).rstrip("/")
    if base.startswith("http://") and not ("localhost" in base or "127.0.0.1" in base):
        base = "https://" + base[len("http://"):]
    return f"{base}/api/auth/google/login-callback"


def build_login_flow(request, state: str | None = None) -> Flow:
    """OAuth flow for sign-in: identity only."""
    cfg = _client_config()
    if not cfg:
        raise RuntimeError("No Google OAuth client configured.")
    return Flow.from_client_config(cfg, scopes=LOGIN_SCOPES, redirect_uri=login_redirect_uri(request), state=state)


def connect_redirect_uri(request) -> str:
    """Redirect URI for the per-user Connect Google account flow. Must be
    registered in the Google Cloud OAuth client (alongside the login and
    settings callback URIs). Prefer an explicit env value."""
    env = os.getenv("GOOGLE_CONNECT_REDIRECT_URI")
    if env:
        return env
    base = str(request.base_url).rstrip("/")
    if base.startswith("http://") and not ("localhost" in base or "127.0.0.1" in base):
        base = "https://" + base[len("http://"):]
    return f"{base}/api/auth/google-account/callback"


def build_connect_flow(request, state: str | None = None) -> Flow:
    """OAuth flow for the per-user Gmail + Calendar grant."""
    cfg = _client_config()
    if not cfg:
        raise RuntimeError("No Google OAuth client configured.")
    return Flow.from_client_config(cfg, scopes=CONNECT_SCOPES, redirect_uri=connect_redirect_uri(request), state=state)


def client_secret() -> str | None:
    """The OAuth client secret — needed to refresh per-user tokens."""
    csec = os.getenv("GOOGLE_CLIENT_SECRET")
    if csec:
        return csec.strip()
    cfg = _client_config()
    if cfg:
        for key in ("web", "installed"):
            if isinstance(cfg.get(key), dict) and cfg[key].get("client_secret"):
                return cfg[key]["client_secret"]
    return None
