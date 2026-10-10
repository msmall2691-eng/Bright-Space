"""A canned reply must never be served as though the model wrote it.

`/api/ai/draft-conversation-reply` and `/api/ai/draft-lead-reply` answer 200
with hand-written filler whenever the model can't be reached — no API key, a
failed call, an empty completion. That answer used to be indistinguishable
from a real draft: the only `error` either endpoint ever set was "Conversation
not found", so the UI call sites, which checked `res.message && !res.error`,
rendered every failure as a genuine AI suggestion.

The owner hit it directly. A customer asked for one more deep clean before
pausing and mentioned that nobody had come the day before; the thread offered
her "Hi +12075765825, thanks for your message! We'll take care of this and
follow up shortly." Two bugs in one line of UI — filler presented as a draft,
and a phone number used as a first name.

What's pinned is the CONTRACT, not the prose: a fallback is marked, and says
which kind it is, because the two kinds need different answers from whoever
reads it. `unconfigured` means nothing will work until a key is set; `error`
means the call was made and failed, and is usually worth retrying.
"""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, LeadIntake, Message
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7631, 1, "admin", "active", True
    email = "ai-fallback-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def thread():
    """A thread with one unanswered inbound and NO client linked — the shape
    that produced the phone-number greeting. Yields (conversation_id, phone)."""
    phone = "+12075765825"
    db = SessionLocal()
    conv = Conversation(org_id=1, channel="sms", external_contact=phone,
                        subject="", status="open")
    db.add(conv); db.flush()
    db.add(Message(org_id=1, conversation_id=conv.id, direction="inbound",
                   channel="sms", from_addr=phone,
                   body="Any chance for a cleaning over the next week?"))
    db.commit()
    cid = conv.id
    db.close()
    yield cid, phone
    db = SessionLocal()
    db.query(Message).filter(Message.conversation_id == cid).delete(synchronize_session=False)
    db.query(Conversation).filter(Conversation.id == cid).delete(synchronize_session=False)
    db.commit(); db.close()


def _draft(api, cid):
    r = api.post(f"/api/ai/draft-conversation-reply/{cid}", json={})
    assert r.status_code == 200, r.text
    return r.json()


# A model that answers, and one that doesn't.
def _with_model(completion):
    return (patch("modules.ai.router._anthropic_client", return_value=object()),
            patch("modules.ai.router._run_tool_loop", return_value=completion))


class TestTheFallbackIsMarked:
    def test_says_unconfigured_when_there_is_no_api_key(self, api, thread):
        cid, _ = thread
        with patch("modules.ai.router._anthropic_client", return_value=None):
            body = _draft(api, cid)
        assert body["fallback"] == "unconfigured", (
            "an unconfigured assistant must be distinguishable from one that "
            "answered — otherwise the UI shows filler as a draft"
        )
        assert body["message"], "the canned text is still returned for callers that want it"

    def test_says_error_when_the_call_blows_up(self, api, thread):
        cid, _ = thread
        with patch("modules.ai.router._anthropic_client", return_value=object()), \
             patch("modules.ai.router._run_tool_loop", side_effect=RuntimeError("boom")):
            body = _draft(api, cid)
        assert body["fallback"] == "error"

    def test_says_error_when_the_model_returns_nothing(self, api, thread):
        cid, _ = thread
        a, b = _with_model('{"subject": "", "message": "   "}')
        with a, b:
            body = _draft(api, cid)
        assert body["fallback"] == "error"

    def test_a_real_draft_carries_no_fallback_marker(self, api, thread):
        # The other half. Without this, marking EVERY response as a fallback
        # would pass all three cases above while suppressing every real draft.
        cid, _ = thread
        a, b = _with_model('{"subject": "", "message": "Yes — Thursday at 9 works."}')
        with a, b:
            body = _draft(api, cid)
        assert body["message"] == "Yes — Thursday at 9 works."
        assert "fallback" not in body


class TestNobodyIsGreetedByPhoneNumber:
    def test_an_unlinked_conversation_addresses_nobody(self, api, thread):
        # `conv.external_contact` is the normalized phone/email the thread is
        # keyed on. It was used as the name when no client was linked, so the
        # suggested reply opened "Hi +12075765825,".
        cid, phone = thread
        with patch("modules.ai.router._anthropic_client", return_value=None):
            msg = _draft(api, cid)["message"]
        assert phone not in msg, f"greeted the customer by their phone number: {msg!r}"
        assert phone.lstrip("+") not in msg, f"greeted the customer by their phone number: {msg!r}"
        assert msg.startswith("Hi there,"), msg

    def test_a_linked_client_still_gets_their_first_name(self, api, thread):
        # The fix must not flatten everyone to "there" — that would pass the
        # case above while making every draft colder.
        cid, phone = thread
        db = SessionLocal()
        c = Client(org_id=1, name="Anna Sweet", phone=phone)
        db.add(c); db.flush()
        cid_client = c.id
        db.query(Conversation).filter(Conversation.id == cid).update({"client_id": cid_client})
        db.commit(); db.close()
        try:
            with patch("modules.ai.router._anthropic_client", return_value=None):
                msg = _draft(api, cid)["message"]
            assert msg.startswith("Hi Anna,"), msg
        finally:
            db = SessionLocal()
            db.query(Conversation).filter(Conversation.id == cid).update({"client_id": None})
            db.query(Client).filter(Client.id == cid_client).delete(synchronize_session=False)
            db.commit(); db.close()


class TestTheLeadDraftToo:
    """The same masquerade on the Requests drawer's draft button."""

    def test_lead_fallback_is_marked_and_still_personalized(self, api):
        db = SessionLocal()
        lead = LeadIntake(org_id=1, name="Dana Lowell", phone="+12075550143",
                          service_type="residential", source="website", status="new")
        db.add(lead); db.commit(); lid = lead.id
        db.close()
        try:
            # BOTH channels. The SMS and email fallbacks are separate return
            # statements, and a mutation that dropped the marker from only the
            # email one survived a test that checked SMS alone.
            for channel in ("sms", "email"):
                with patch("modules.ai.router._anthropic_client", return_value=None):
                    r = api.post(f"/api/ai/draft-lead-reply/{lid}", json={"channel": channel})
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["fallback"] == "unconfigured", f"{channel}: {body!r}"
                assert "Dana" in body["message"], f"{channel}: canned text lost its personalization"
        finally:
            db = SessionLocal()
            db.query(LeadIntake).filter(LeadIntake.id == lid).delete(synchronize_session=False)
            db.commit(); db.close()
