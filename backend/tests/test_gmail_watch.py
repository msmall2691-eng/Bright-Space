"""Real-time Gmail push scaffold (integrations.gmail_watch).

Hermetic — no Google, no Pub/Sub. Exercises the webhook handler's auth, payload
decode, account resolution, and safe no-op paths. The actual sync is stubbed.
"""
import base64
import json
import uuid

import pytest

import integrations.gmail_watch as gw
from database.db import SessionLocal
from database.models import UserGoogleAccount


def _push_body(email, history_id="123"):
    data = base64.b64encode(json.dumps(
        {"emailAddress": email, "historyId": history_id}).encode()).decode()
    return {"message": {"data": data, "messageId": "m1"}}


@pytest.fixture
def topic_env(monkeypatch):
    monkeypatch.setenv("GMAIL_PUBSUB_TOPIC", "projects/p/topics/gmail-push")
    monkeypatch.setenv("GMAIL_PUBSUB_VERIFICATION_TOKEN", "s3cret")


def test_is_configured_reflects_topic(monkeypatch):
    monkeypatch.delenv("GMAIL_PUBSUB_TOPIC", raising=False)
    assert gw.is_configured() is False
    monkeypatch.setenv("GMAIL_PUBSUB_TOPIC", "projects/p/topics/t")
    assert gw.is_configured() is True


def test_handle_push_rejects_bad_token(topic_env):
    db = SessionLocal()
    try:
        out = gw.handle_push(db, "wrong-token", _push_body("a@b.com"))
        assert out == {"ok": False, "error": "unauthenticated"}
    finally:
        db.close()


def test_handle_push_bad_payload(topic_env):
    db = SessionLocal()
    try:
        out = gw.handle_push(db, "s3cret", {"message": {"data": "!!notbase64!!"}})
        assert out["ok"] is False and out["error"] in ("bad_payload", "no_email")
    finally:
        db.close()


def test_handle_push_no_matching_account_is_acked(topic_env):
    db = SessionLocal()
    try:
        out = gw.handle_push(db, "s3cret", _push_body(f"nobody-{uuid.uuid4().hex}@x.com"))
        assert out == {"ok": True, "skipped": "no_matching_account"}
    finally:
        db.close()


def test_handle_push_runs_sync_for_matching_account(topic_env, monkeypatch):
    email = f"agent-{uuid.uuid4().hex[:6]}@biz.com"
    db = SessionLocal()
    acc = UserGoogleAccount(
        user_id=1, org_id=1, google_sub=uuid.uuid4().hex, email=email,
        scopes="gmail.readonly", status="connected", gmail_sync_enabled=True,
    )
    db.add(acc); db.commit(); db.refresh(acc)
    calls = {}

    def _fake_sync(_db, account, **kw):
        calls["email"] = account.email
        return {"summary": {"total": 1, "threaded": 1}}

    import modules.gmail.router as gmr
    monkeypatch.setattr(gmr, "run_account_inbox_sync", _fake_sync)
    try:
        out = gw.handle_push(db, "s3cret", _push_body(email))
        assert out["ok"] is True
        assert out["email"] == email
        assert calls["email"] == email        # the matched account was synced
    finally:
        db.query(UserGoogleAccount).filter(UserGoogleAccount.id == acc.id).delete()
        db.commit(); db.close()


def test_register_all_noop_when_unconfigured(monkeypatch):
    monkeypatch.delenv("GMAIL_PUBSUB_TOPIC", raising=False)
    db = SessionLocal()
    try:
        out = gw.register_all(db)
        assert out["ok"] is False   # disabled/unconfigured — nothing registered
    finally:
        db.close()
