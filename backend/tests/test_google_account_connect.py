"""Phase B/C of docs/auth-workspaces-plan-2026-06.md: per-user Google grant.

Covers: token encryption at rest, the connect callback upsert, sync toggles,
disconnect, refresh-failure handling (status='expired', not a crash), login
scopes staying identity-only, and Gmail-sync provenance stamping.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from cryptography.fernet import Fernet

from database.db import SessionLocal
from database.models import User, UserGoogleAccount, Message, Conversation


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
    db = SessionLocal()
    u = User(email="connector@example.com", full_name="Connector", role="member",
             active=True, status="active")
    db.add(u); db.commit(); db.refresh(u)
    yield db, u
    db.rollback()
    db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).delete(synchronize_session=False)
    conv_ids = [cid for (cid,) in db.query(Conversation.id).filter(Conversation.client_id.is_(None))]
    db.query(User).filter(User.id == u.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_crypto_roundtrip_and_key_required(monkeypatch):
    from utils.crypto import encrypt_secret, decrypt_secret, TokenEncryptionUnavailable
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
    token = encrypt_secret("ya29.secret")
    assert token != "ya29.secret"
    assert decrypt_secret(token) == "ya29.secret"

    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY")
    with pytest.raises(TokenEncryptionUnavailable):
        encrypt_secret("x")


def test_login_scopes_are_identity_only():
    """Sign-in must never again silently capture calendar access."""
    from integrations.google_oauth import LOGIN_SCOPES, CONNECT_SCOPES
    assert not any("calendar" in s or "gmail" in s for s in LOGIN_SCOPES)
    assert any("gmail.readonly" in s for s in CONNECT_SCOPES)
    assert any(s.endswith("/calendar") for s in CONNECT_SCOPES)


def _fake_flow(refresh_token="rt-1"):
    flow = MagicMock()
    creds = MagicMock()
    creds.token = "at-1"
    creds.refresh_token = refresh_token
    creds.expiry = datetime.now() + timedelta(hours=1)
    creds.scopes = ["openid", "https://www.googleapis.com/auth/gmail.readonly",
                    "https://www.googleapis.com/auth/calendar"]
    creds.id_token = "idtok"
    flow.credentials = creds
    return flow


def _run_callback(db, user, state="st1", flow=None):
    from modules.auth.router import google_account_callback, _app_set
    _app_set(db, f"gconnect_state_{state}", f"{user.id}|{datetime.now(timezone.utc).isoformat()}")
    db.commit()
    with patch("integrations.google_oauth.build_connect_flow", return_value=flow or _fake_flow()), \
         patch("google.oauth2.id_token.verify_oauth2_token",
               return_value={"email": "connector@gmail.com", "email_verified": True, "sub": "sub-123"}), \
         patch("integrations.google_oauth.client_id", return_value="cid"):
        return google_account_callback(request=None, code="code", state=state, db=db)


def test_connect_callback_stores_encrypted_grant_with_sync_on(ctx):
    db, u = ctx
    resp = _run_callback(db, u)
    assert "google_account=connected" in resp.headers["location"]
    acct = db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).one()
    assert acct.email == "connector@gmail.com"
    assert acct.google_sub == "sub-123"
    assert acct.status == "connected"
    assert acct.gmail_sync_enabled and acct.gcal_sync_enabled  # sync defaults ON
    # Tokens are NOT stored in plaintext.
    assert acct.access_token and "at-1" not in acct.access_token
    assert acct.refresh_token and "rt-1" not in acct.refresh_token
    from utils.crypto import decrypt_secret
    assert decrypt_secret(acct.access_token) == "at-1"
    assert decrypt_secret(acct.refresh_token) == "rt-1"


def test_reconnect_without_refresh_token_keeps_existing_one(ctx):
    """Google omits the refresh token on re-consent — we must not wipe ours."""
    db, u = ctx
    _run_callback(db, u, state="st1")
    _run_callback(db, u, state="st2", flow=_fake_flow(refresh_token=None))
    acct = db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).one()
    from utils.crypto import decrypt_secret
    assert decrypt_secret(acct.refresh_token) == "rt-1"   # survived


def test_callback_rejects_bad_or_replayed_state(ctx):
    db, u = ctx
    from modules.auth.router import google_account_callback
    resp = google_account_callback(request=None, code="c", state="never-issued", db=db)
    assert "invalid_state" in resp.headers["location"]
    # A used state can't be replayed.
    _run_callback(db, u, state="once")
    resp = google_account_callback(request=None, code="c", state="once", db=db)
    assert "invalid_state" in resp.headers["location"]


def test_toggles_and_disconnect(ctx):
    db, u = ctx
    _run_callback(db, u)
    from modules.auth.router import update_google_account, disconnect_google_account, GoogleAccountUpdate
    row = update_google_account(GoogleAccountUpdate(gmail_sync_enabled=False), db=db, current_user=u)
    assert row["gmail_sync_enabled"] is False and row["gcal_sync_enabled"] is True

    with patch("httpx.post") as revoke:
        out = disconnect_google_account(db=db, current_user=u)
    assert out == {"connected": False}
    assert revoke.called  # best-effort revoke at Google
    assert db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).count() == 0


def test_refresh_failure_marks_expired_not_crash(ctx):
    db, u = ctx
    _run_callback(db, u)
    acct = db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).one()
    acct.token_expiry = datetime.now() - timedelta(hours=1)  # force a refresh
    db.commit()
    from integrations.google_accounts import account_credentials, AccountCredentialsError
    with patch("google.oauth2.credentials.Credentials.refresh", side_effect=Exception("invalid_grant")):
        with pytest.raises(AccountCredentialsError):
            account_credentials(db, acct)
    db.refresh(acct)
    assert acct.status == "expired"
    assert "refresh failed" in (acct.last_sync_error or "")


def test_account_sync_stamps_provenance(ctx):
    """Emails synced through a member's account record WHICH account."""
    db, u = ctx
    _run_callback(db, u)
    acct = db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).one()

    from database.models import Client
    client = Client(name="Prov Test", email="prov@example.com", status="active")
    db.add(client); db.commit(); db.refresh(client)
    try:
        from modules.gmail.router import run_inbox_sync
        emails = [{"id": "g1", "message_id": "<prov-1@mail>", "from_name": "Prov Test",
                   "from_email": "prov@example.com", "to": "connector@gmail.com",
                   "subject": "hello", "snippet": "hi", "body": "hi",
                   "date": datetime.now(timezone.utc).isoformat(), "is_read": False,
                   "has_attachments": False}]
        result = run_inbox_sync(db, emails=emails, source_account_id=acct.id)
        assert result["summary"]["threaded"] == 1
        msg = db.query(Message).filter(Message.external_id == "<prov-1@mail>").one()
        assert msg.synced_by_google_account_id == acct.id
        conv = db.query(Conversation).filter(Conversation.id == msg.conversation_id).one()
        assert conv.synced_by_google_account_id == acct.id
    finally:
        msg = db.query(Message).filter(Message.external_id == "<prov-1@mail>").first()
        if msg:
            conv_id = msg.conversation_id
            db.delete(msg); db.commit()
            conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
            if conv:
                db.delete(conv); db.commit()
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit()


def test_disconnect_clears_provenance_references(ctx):
    """Codex P1 (#265): rows synced by the account reference it via FKs with
    no ON DELETE SET NULL — disconnect must detach them or the delete 500s on
    Postgres after the token was already revoked at Google."""
    db, u = ctx
    _run_callback(db, u)
    acct = db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).one()

    from database.models import Client, Job, Property
    client = Client(name="Disc Prov", email="discprov@example.com", status="active")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="P", address="1 St",
                    property_type="residential", active=True)
    db.add(prop); db.commit(); db.refresh(prop)
    job = Job(client_id=client.id, property_id=prop.id, title="J", job_type="residential",
              gcal_event_id="evt1", gcal_account_id=acct.id)
    db.add(job); db.commit(); db.refresh(job)
    try:
        from modules.gmail.router import run_inbox_sync
        emails = [{"id": "g2", "message_id": "<disc-prov@mail>", "from_name": "Disc Prov",
                   "from_email": "discprov@example.com", "to": "x@y.z", "subject": "hi",
                   "snippet": "hi", "body": "hi",
                   "date": datetime.now(timezone.utc).isoformat(), "is_read": False,
                   "has_attachments": False}]
        run_inbox_sync(db, emails=emails, source_account_id=acct.id)
        db.commit()

        from modules.auth.router import disconnect_google_account
        with patch("httpx.post"):
            out = disconnect_google_account(db=db, current_user=u)
        assert out == {"connected": False}
        assert db.query(UserGoogleAccount).filter(UserGoogleAccount.user_id == u.id).count() == 0
        # Synced data survives, detached from the deleted grant.
        msg = db.query(Message).filter(Message.external_id == "<disc-prov@mail>").one()
        assert msg.synced_by_google_account_id is None
        conv = db.query(Conversation).filter(Conversation.id == msg.conversation_id).one()
        assert conv.synced_by_google_account_id is None
        db.refresh(job)
        assert job.gcal_account_id is None
    finally:
        msg = db.query(Message).filter(Message.external_id == "<disc-prov@mail>").first()
        if msg:
            conv_id = msg.conversation_id
            db.delete(msg); db.commit()
            conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
            if conv:
                db.delete(conv); db.commit()
        db.query(Job).filter(Job.id == job.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit()


def test_calendar_mutations_route_to_the_owning_account():
    """Codex P1 (#265): update/cancel must hit the calendar the event lives
    on — the recorded owner — not whichever account connected most recently."""
    import integrations.google_calendar as gc

    # An explicit owner routes to exactly that account.
    with patch.object(gc, "_account_service", return_value="svc-7") as acct_svc:
        assert gc._get_service(7) == "svc-7"
    acct_svc.assert_called_once_with(7)

    # Owner None = legacy event: the per-user path must NOT be consulted.
    with patch.object(gc, "_account_service", return_value="svc-x") as acct_svc, \
         patch.object(gc, "_load_db_token", return_value=None), \
         patch.dict("os.environ", {"GOOGLE_TOKEN_B64": ""}, clear=False):
        with pytest.raises(RuntimeError):
            gc._get_service(None)   # falls to the legacy chain (unconfigured here)
    acct_svc.assert_not_called()

    # Default (new events / reads): newest connected account is preferred.
    with patch.object(gc, "_account_service", return_value="svc-new") as acct_svc:
        assert gc._get_service() == "svc-new"
    acct_svc.assert_called_once_with(None)

    # And the mutation wrappers pass the owner through.
    with patch.object(gc, "_get_service", return_value=MagicMock()) as get_svc:
        gc.delete_event("evt", "residential", owner_account_id=42)
    get_svc.assert_called_once_with(42)
