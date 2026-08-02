"""Send-through-Gmail: emails go out via the sender's connected Gmail (real
Sent + threaded via In-Reply-To) when available, else SMTP. Hermetic — the
Gmail service and SMTP are stubbed.
"""
import base64
import uuid

import pytest

import integrations.gmail_api as ga
import modules.comms.router as comms
from database.db import SessionLocal
from database.models import UserGoogleAccount, Conversation, Message


# ── send_message primitive ─────────────────────────────────────────────────

class _SendMessages:
    def __init__(self, sink): self._sink = sink
    def send(self, userId, body):
        self._sink["body"] = body
        class _E:
            def execute(_s): return {"id": "sent1", "threadId": "t1"}
        return _E()


class _SendUsers:
    def __init__(self, sink): self._sink = sink
    def messages(self): return _SendMessages(self._sink)


class _SendService:
    def __init__(self, sink): self._sink = sink
    def users(self): return _SendUsers(self._sink)


def test_send_message_builds_threaded_mime(monkeypatch):
    sink = {}
    monkeypatch.setattr(ga, "_service", lambda creds: _SendService(sink))
    out = ga.send_message(
        object(), to="cust@example.com", subject="Re: Quote",
        html_body="<p>hi</p>", from_addr="me@biz.com",
        in_reply_to="<orig@mail.gmail.com>",
    )
    assert out["id"] == "sent1" and out["threadId"] == "t1"
    assert out["message_id"].startswith("<")           # generated RFC Message-ID
    raw = base64.urlsafe_b64decode(sink["body"]["raw"]).decode()
    assert "To: cust@example.com" in raw
    assert "From: me@biz.com" in raw
    assert "In-Reply-To: <orig@mail.gmail.com>" in raw
    assert "References: <orig@mail.gmail.com>" in raw   # threads the conversation


# ── endpoint helper: Gmail vs SMTP selection ───────────────────────────────

class _User:
    def __init__(self, uid): self.id = uid


def test_helper_prefers_gmail_when_send_scope(monkeypatch):
    db = SessionLocal()
    acc = UserGoogleAccount(
        user_id=91001, org_id=1, google_sub=uuid.uuid4().hex,
        email="agent@biz.com", status="connected",
        scopes=["https://www.googleapis.com/auth/gmail.send",
                "https://www.googleapis.com/auth/gmail.readonly"],
        gmail_sync_enabled=True,
    )
    conv = Conversation(channel="email", status="open", org_id=1)
    db.add_all([acc, conv]); db.commit(); db.refresh(acc); db.refresh(conv)

    monkeypatch.setattr("integrations.google_accounts.account_credentials",
                        lambda db_, a: object())
    sent = {}
    monkeypatch.setattr(ga, "send_message",
                        lambda creds, **kw: (sent.update(kw), {"message_id": "<new@biz>"})[1])
    # SMTP must NOT be called on the Gmail path.
    monkeypatch.setattr(comms, "_send_email",
                        lambda **kw: pytest.fail("SMTP should not be used"))
    try:
        from_addr, ext = comms._send_email_via_gmail_or_smtp(
            db, _User(91001), to="c@x.com", subject="Hi", body="<p>x</p>", conv=conv)
        assert from_addr == "agent@biz.com"
        assert ext == "<new@biz>"
        assert sent["to"] == "c@x.com"
    finally:
        db.query(Message).filter(Message.conversation_id == conv.id).delete()
        db.query(Conversation).filter(Conversation.id == conv.id).delete()
        db.query(UserGoogleAccount).filter(UserGoogleAccount.id == acc.id).delete()
        db.commit(); db.close()


def test_helper_falls_back_to_smtp_without_account(monkeypatch):
    db = SessionLocal()
    conv = Conversation(channel="email", status="open", org_id=1)
    db.add(conv); db.commit(); db.refresh(conv)
    called = {}
    monkeypatch.setattr(comms, "_send_email",
                        lambda **kw: called.update({"to": kw.get("to")}))
    try:
        from_addr, ext = comms._send_email_via_gmail_or_smtp(
            db, _User(99999), to="c@x.com", subject="Hi", body="<p>x</p>", conv=conv)
        assert ext is None                 # SMTP has no RFC id to record
        assert called["to"] == "c@x.com"   # SMTP path taken
    finally:
        db.query(Conversation).filter(Conversation.id == conv.id).delete()
        db.commit(); db.close()
