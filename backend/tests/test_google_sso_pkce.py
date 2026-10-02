"""Google sign-in PKCE verifier must survive the auth-request → callback hop.

The bug (BB-AUTH-PKCE): google-auth-oauthlib auto-enables PKCE, so
`login-url` builds a Flow whose `authorization_url()` generates a
`code_verifier` and sends its S256 challenge to Google. That verifier lived
only on that one in-memory Flow. `login-callback` then built a BRAND-NEW Flow
and called `fetch_token()` with no verifier at all, so Google rejected every
exchange ("Missing code verifier") → `?sso_error=failed` → the "Google sign-in
failed. Please try again." banner. Nobody could sign in with Google.

The fix persists the verifier next to the state nonce and re-applies it to the
callback's fresh Flow. These lock that in for the two auth-router flows that
carry the same defect (sign-in and per-user connect).
"""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

from database.db import SessionLocal
from database.models import AppSetting, User


class _PkceFlow:
    """Stand-in for google-auth-oauthlib's Flow, reproducing the one behaviour
    this bug turns on: authorization_url() sets `code_verifier` as a side
    effect, and whatever `code_verifier` is on the object at fetch_token() time
    is what would be sent to Google."""

    def __init__(self, generated_verifier=None):
        self._generated = generated_verifier
        self.code_verifier = None                     # a fresh Flow starts with none
        self.credentials = MagicMock(id_token="idtok")
        self.fetched_verifier = "<never-called>"

    def authorization_url(self, **kw):
        self.code_verifier = self._generated          # the real side effect
        return ("https://accounts.google.com/o/oauth2/auth?code_challenge=x", "state")

    def fetch_token(self, **kw):
        # Capture the verifier the caller committed us to for the exchange.
        self.fetched_verifier = self.code_verifier


def _cleanup(db):
    db.query(AppSetting).filter(AppSetting.key.like("sso_state_%")).delete(synchronize_session=False)
    db.query(AppSetting).filter(AppSetting.key.like("sso_code_%")).delete(synchronize_session=False)
    db.query(AppSetting).filter(AppSetting.key.like("gconnect_state_%")).delete(synchronize_session=False)
    db.commit()


def test_signin_verifier_generated_at_login_url_is_used_at_callback(monkeypatch):
    import modules.auth.router as auth_router
    from modules.auth.router import google_login_url, google_login_callback, _app_get

    db = SessionLocal()
    try:
        _cleanup(db)
        flows = []

        def _build(request, state=None):
            # First call (login-url) generates a verifier; the second call
            # (the callback) is a fresh Flow with none — exactly the two-Flow
            # split that dropped the verifier before the fix.
            f = _PkceFlow(generated_verifier="verifier-abc123" if not flows else None)
            f.state_arg = state
            flows.append(f)
            return f

        monkeypatch.setattr("integrations.google_oauth.build_login_flow", _build)
        monkeypatch.setattr("integrations.google_oauth.is_oauth_available", lambda: True)
        monkeypatch.setattr("integrations.google_oauth.client_id", lambda: "cid")
        monkeypatch.setattr(
            "google.oauth2.id_token.verify_oauth2_token",
            lambda *a, **k: {"aud": "cid", "email": "office@mainecleaninco.com",
                             "email_verified": True, "sub": "sub-1", "name": "Office"},
        )
        # Keep the test on the OAuth mechanics, not user provisioning.
        monkeypatch.setattr(auth_router, "_resolve_google_user",
                            lambda db, email, sub, name: SimpleNamespace(id=1, email=email, role="admin"))

        # 1) Start sign-in — the verifier is generated here and must be stored.
        out = google_login_url(request=None, db=db)
        assert out["enabled"] is True
        assert flows[0].code_verifier == "verifier-abc123"
        state = flows[0].state_arg

        stored = _app_get(db, f"sso_state_{state}")
        assert stored is not None
        assert stored.endswith("|verifier-abc123")   # persisted with the nonce

        # 2) Complete sign-in — the fresh callback Flow must exchange WITH that
        #    verifier (the whole bug). It should succeed, not bounce to sso_error.
        resp = google_login_callback(request=None, code="authcode", state=state, db=db)
        assert flows[1].fetched_verifier == "verifier-abc123"
        assert flows[1].fetched_verifier == flows[0].code_verifier
        loc = resp.headers["location"]
        assert "sso_code=" in loc and "sso_error" not in loc
    finally:
        _cleanup(db)
        db.close()


def test_signin_callback_tolerates_pre_fix_state_rows(monkeypatch):
    """A state row written before the fix is the bare timestamp with no
    '|verifier' suffix. It must still parse (verifier simply absent), not crash
    on the new split — so an in-flight login mid-deploy isn't wedged."""
    from modules.auth.router import google_login_callback, _app_set

    db = SessionLocal()
    try:
        _cleanup(db)
        captured = {}

        def _build(request, state=None):
            f = _PkceFlow()
            captured["flow"] = f
            return f

        monkeypatch.setattr("integrations.google_oauth.build_login_flow", _build)
        monkeypatch.setattr("integrations.google_oauth.client_id", lambda: "cid")
        monkeypatch.setattr(
            "google.oauth2.id_token.verify_oauth2_token",
            lambda *a, **k: {"aud": "cid", "email": "office@mainecleaninco.com",
                             "email_verified": True, "sub": "sub-1", "name": "Office"},
        )
        import modules.auth.router as auth_router
        monkeypatch.setattr(auth_router, "_resolve_google_user",
                            lambda db, email, sub, name: SimpleNamespace(id=1, email=email, role="admin"))

        state = "legacy-state-row"
        _app_set(db, f"sso_state_{state}", datetime.now(timezone.utc).isoformat())  # old 1-field shape
        db.commit()

        resp = google_login_callback(request=None, code="authcode", state=state, db=db)
        # No verifier to apply; the exchange still runs and the login completes.
        assert captured["flow"].code_verifier is None
        assert "sso_code=" in resp.headers["location"]
    finally:
        _cleanup(db)
        db.close()


def test_connect_verifier_reaches_the_callback_flow(monkeypatch):
    """The per-user Gmail/Calendar connect flow has the same shape and the same
    fix: a verifier appended to the gconnect_state row must be re-applied to the
    callback's fresh Flow before fetch_token."""
    from modules.auth.router import google_account_callback, _app_set

    db = SessionLocal()
    u = User(email="pkce-connector@example.com", full_name="Connector",
             role="member", active=True, status="active")
    db.add(u); db.commit(); db.refresh(u)
    try:
        _cleanup(db)
        captured = {}

        class _RaiseAfterCapture(_PkceFlow):
            def fetch_token(self, **kw):
                # Record the applied verifier, then stop before the downstream
                # token-encryption/account-upsert machinery this test doesn't
                # exercise — the callback turns this into a graceful redirect.
                self.fetched_verifier = self.code_verifier
                raise RuntimeError("stop after verifier applied")

        def _build(request, state=None):
            f = _RaiseAfterCapture()
            captured["flow"] = f
            return f

        monkeypatch.setattr("integrations.google_oauth.build_connect_flow", _build)
        monkeypatch.setattr("integrations.google_oauth.client_id", lambda: "cid")

        state = "connect-state-1"
        _app_set(db, f"gconnect_state_{state}",
                 f"{u.id}|{datetime.now(timezone.utc).isoformat()}|verifier-xyz789")
        db.commit()

        resp = google_account_callback(request=None, code="authcode", state=state, db=db)
        assert captured["flow"].fetched_verifier == "verifier-xyz789"
        # fetch_token raised → the callback redirects gracefully, never 500s.
        assert resp.status_code == 302
        assert "google_account=failed" in resp.headers["location"]
    finally:
        _cleanup(db)
        db.query(User).filter(User.id == u.id).delete(synchronize_session=False)
        db.commit(); db.close()
