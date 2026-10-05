"""`GET /api/comms/client/{id}` must not lose a channel.

BB-VOICE-01 has the Twilio voice webhook writing `channel="voice"`, but this
endpoint's per-channel counts were hardcoded to `sms` and `email`. A client
whose only contact was an inbound call therefore counted as zero of
everything, while their voicemail transcripts WERE returned in the flat
`messages` list — so the number and the list disagreed with each other.

The frontend had the matching half of the bug: it filtered the flat list to
`sms` and `email`, so a voicemail was fetched and then dropped. Fixing the
count alone would have left the data invisible, which is why both moved
together.

These assert the shape the UI depends on, not the internals.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7811, 1, "admin", "active", True
    email = "comms-voice@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _client_with_channels(*channels):
    """A client with one conversation per channel, one inbound message each."""
    db = SessionLocal()
    cl = Client(name=f"Voice {uuid.uuid4().hex[:5]}", email="voice@example.com",
                phone="+12075550199", status="active", org_id=1)
    db.add(cl); db.commit(); db.refresh(cl)
    for ch in channels:
        conv = Conversation(client_id=cl.id, channel=ch, status="open", org_id=1)
        db.add(conv); db.commit(); db.refresh(conv)
        db.add(Message(
            conversation_id=conv.id, client_id=cl.id, channel=ch,
            direction="inbound", body=f"a {ch} message",
            subject="Voicemail from +1 207 555 0199" if ch == "voice" else None,
            org_id=1,
        ))
        db.commit()
    cid = cl.id
    db.close()
    return cid


def test_voice_conversation_is_counted(api):
    cid = _client_with_channels("voice")
    body = api.get(f"/api/comms/client/{cid}").json()
    assert body["counts"]["voice"] == 1, body["counts"]
    # And the transcript itself comes back, which is what the client profile renders.
    assert [m["body"] for m in body["messages"]] == ["a voice message"]
    assert body["messages"][0]["channel"] == "voice"


def test_each_channel_counted_separately(api):
    cid = _client_with_channels("sms", "email", "voice")
    counts = api.get(f"/api/comms/client/{cid}").json()["counts"]
    assert counts["sms"] == 1
    assert counts["email"] == 1
    assert counts["voice"] == 1


def test_absent_channel_reports_zero_rather_than_missing(api):
    # The UI reads counts.voice unconditionally; a missing key would be a
    # different bug than a zero.
    cid = _client_with_channels("sms")
    counts = api.get(f"/api/comms/client/{cid}").json()["counts"]
    assert counts["voice"] == 0
    assert counts["sms"] == 1


def test_total_still_counts_messages_not_conversations(api):
    # Documented asymmetry that predates this change: the per-channel entries
    # count CONVERSATIONS, `total` counts MESSAGES. Pinned so a later "fix" to
    # make them add up is a deliberate choice rather than an accident.
    cid = _client_with_channels("sms", "voice")
    db = SessionLocal()
    conv = (db.query(Conversation)
              .filter(Conversation.client_id == cid, Conversation.channel == "sms")
              .first())
    db.add(Message(conversation_id=conv.id, client_id=cid, channel="sms",
                   direction="outbound", body="a second sms", org_id=1))
    db.commit(); db.close()

    body = api.get(f"/api/comms/client/{cid}").json()
    assert body["counts"]["sms"] == 1          # still ONE sms conversation
    assert body["counts"]["total"] == 3        # but THREE messages
