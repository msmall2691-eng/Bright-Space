"""Inbound voice + voicemail webhook (BB-VOICE-01).

Pins the September-2026 outage. The Twilio number's Voice webhook pointed at
/api/twilio/voice, a route this app has never had. The API-key middleware
answered Twilio with a 401, Twilio had no TwiML to run, and every inbound
call died at 0 seconds (Twilio error 11200) — from 2026-04-29 through
2026-09-14, nobody could reach the business by phone and no one knew.

Two classes of regression are pinned here:

  1. The voice routes are PUBLIC. If a future edit drops the auth.py
     allowlist entry, the middleware eats the webhook again and the phone
     goes silently dead — the exact failure above. _is_public is asserted
     directly because tests/conftest.py injects an API key on every
     TestClient request, so an integration test cannot see that 401.

  2. Signature checking still fails CLOSED, like the SMS webhook, so the
     public routes can't be used to inject records under a real client's
     number or to make Twilio text the on-call line for free.
"""
import pytest
from fastapi.testclient import TestClient
from twilio.request_validator import RequestValidator

from main import app
from auth import _is_public

client = TestClient(app)

VOICE_PATHS = [
    "/api/comms/twilio/voice",
    "/api/comms/twilio/voice/after-dial",
    "/api/comms/twilio/voice/after-record",
    "/api/comms/twilio/voice/recording",
    "/api/comms/twilio/voice/transcription",
]


def _signed(path, params, token="test-token-for-valid-sig"):
    """POST to `path` with a signature Twilio would have produced."""
    url = f"http://testserver{path}"
    signature = RequestValidator(token).compute_signature(url, params)
    return client.post(path, data=params, headers={"X-Twilio-Signature": signature})


# --- 1. the outage itself -------------------------------------------------

@pytest.mark.parametrize("path", VOICE_PATHS)
def test_voice_routes_are_public(path):
    """The auth middleware must not intercept Twilio's callbacks.

    This is the assertion that would have caught the outage. Twilio cannot
    send an API key, so a non-public voice route means a 401 and a dead
    phone line.
    """
    assert _is_public(path), f"{path} is not in auth.py's public allowlist — Twilio will get a 401"


def test_public_prefix_does_not_open_unrelated_neighbours():
    """The allowlist entry is a prefix for a real family of five callbacks.

    It should not have opened the whole /api/comms/twilio stem or anything
    else that merely starts similarly.
    """
    assert not _is_public("/api/comms/twilio")
    assert not _is_public("/api/comms/twilio/vox")
    assert not _is_public("/api/comms/messages")


# --- 2. fail-closed signature checking ------------------------------------

@pytest.mark.parametrize("path", VOICE_PATHS)
def test_rejects_when_twilio_auth_token_is_unset(monkeypatch, path):
    monkeypatch.delenv("TWILIO_AUTH_TOKEN", raising=False)
    r = client.post(path, data={"From": "+12075551234", "To": "+12075033301", "CallSid": "CA1"})
    assert r.status_code == 403


@pytest.mark.parametrize("path", VOICE_PATHS)
def test_rejects_bad_signature(monkeypatch, path):
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "test-token-not-matching-signature")
    r = client.post(
        path,
        data={"From": "+12075551234", "To": "+12075033301", "CallSid": "CA2"},
        headers={"X-Twilio-Signature": "definitely-not-valid"},
    )
    assert r.status_code == 403


# --- 3. the TwiML Twilio actually receives --------------------------------

@pytest.fixture
def twilio_token(monkeypatch):
    token = "test-token-for-valid-sig"
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", token)
    monkeypatch.setenv("TWILIO_PHONE_NUMBER", "+12075033301")
    return token


def test_incoming_call_rings_the_forward_number(monkeypatch, twilio_token):
    monkeypatch.setenv("VOICE_FORWARD_TO", "+12075559876")
    r = _signed("/api/comms/twilio/voice", {
        "From": "+12074329492", "To": "+12075033301", "CallSid": "CAring1",
    })
    assert r.status_code == 200, r.text
    assert "text/xml" in r.headers["content-type"]
    body = r.text
    assert "<Dial" in body
    assert "+12075559876" in body
    # The action URL is what turns an unanswered ring into a voicemail.
    assert "/api/comms/twilio/voice/after-dial" in body
    # callerId must be the business line: Twilio rejects a callerId the
    # account neither owns nor has verified, and rejecting it drops the call.
    assert 'callerId="+12075033301"' in body


def test_incoming_call_goes_straight_to_voicemail_with_no_forward_number(monkeypatch, twilio_token):
    monkeypatch.delenv("VOICE_FORWARD_TO", raising=False)
    monkeypatch.delenv("FORWARD_INBOUND_SMS_TO", raising=False)
    r = _signed("/api/comms/twilio/voice", {
        "From": "+12074329492", "To": "+12075033301", "CallSid": "CAvm1",
    })
    assert r.status_code == 200, r.text
    body = r.text
    assert "<Record" in body
    assert "<Dial" not in body
    # A voicemail nobody can read is the status quo this replaces.
    assert "/api/comms/twilio/voice/transcription" in body


def test_answered_call_hangs_up_without_recording(twilio_token):
    r = _signed("/api/comms/twilio/voice/after-dial", {
        "From": "+12074329492", "To": "+12075033301",
        "CallSid": "CAans1", "DialCallStatus": "completed",
    })
    assert r.status_code == 200, r.text
    assert "<Hangup" in r.text
    assert "<Record" not in r.text


@pytest.mark.parametrize("status", ["no-answer", "busy", "failed"])
def test_unanswered_call_takes_a_message(twilio_token, status):
    r = _signed("/api/comms/twilio/voice/after-dial", {
        "From": "+12074329492", "To": "+12075033301",
        "CallSid": f"CAmiss-{status}", "DialCallStatus": status,
    })
    assert r.status_code == 200, r.text
    assert "<Record" in r.text


def test_recording_cap_stays_inside_twilio_transcription_limit(twilio_token, monkeypatch):
    """Twilio only transcribes recordings up to 2 minutes.

    A longer maxLength would silently produce voicemails that record fine and
    never get a transcript — which is the entire feature.
    """
    monkeypatch.delenv("VOICE_FORWARD_TO", raising=False)
    monkeypatch.delenv("FORWARD_INBOUND_SMS_TO", raising=False)
    r = _signed("/api/comms/twilio/voice", {
        "From": "+12074329492", "To": "+12075033301", "CallSid": "CAlen1",
    })
    import re
    m = re.search(r'maxLength="(\d+)"', r.text)
    assert m, r.text
    assert int(m.group(1)) <= 120


# --- 4. what lands in the inbox -------------------------------------------

def _voice_rows(call_sid):
    from database.db import SessionLocal
    from database.models import Message
    db = SessionLocal()
    try:
        return db.query(Message).filter(Message.external_id == call_sid).all()
    finally:
        db.close()


def test_missed_call_lands_in_the_inbox_as_one_row(twilio_token):
    """A missed call with no voicemail is still information she needs.

    The seven calls that died in the outage left no trace anywhere she looks
    — that is why it went unnoticed for five months.
    """
    sid = "CAinbox-missed"
    _signed("/api/comms/twilio/voice/after-dial", {
        "From": "+12072107291", "To": "+12075033301",
        "CallSid": sid, "DialCallStatus": "no-answer",
    })
    rows = _voice_rows(sid)
    assert len(rows) == 1
    msg = rows[0]
    assert msg.channel == "voice"
    assert msg.direction == "inbound"
    assert msg.from_addr == "+12072107291"
    assert "missed call" in (msg.body or "").lower()
    assert msg.conversation_id is not None


def test_transcript_updates_the_same_row_instead_of_adding_one(monkeypatch, twilio_token):
    """after-dial, the recording callback and the transcript are one call.

    Keyed on CallSid so the inbox shows a single entry that fills in, not
    three rows for one caller.
    """
    monkeypatch.setattr("integrations.twilio_client.send_sms",
                        lambda **kw: {"sid": "SM_test"})
    monkeypatch.setenv("VOICE_FORWARD_TO", "+12075559876")

    sid = "CAinbox-vm"
    common = {"From": "+12074329492", "To": "+12075033301", "CallSid": sid}

    _signed("/api/comms/twilio/voice/after-dial", {**common, "DialCallStatus": "no-answer"})
    _signed("/api/comms/twilio/voice/recording", {
        **common,
        "RecordingUrl": "https://api.twilio.com/rec/RE1",
        "RecordingDuration": "42",
        "RecordingStatus": "completed",
    })
    _signed("/api/comms/twilio/voice/transcription", {
        **common,
        "RecordingUrl": "https://api.twilio.com/rec/RE1",
        "RecordingSid": "RE1",
        "TranscriptionStatus": "completed",
        "TranscriptionText": "Hi, this is Dana, I need a move out clean in Wells next Friday.",
    })

    rows = _voice_rows(sid)
    assert len(rows) == 1, f"expected one inbox row per call, got {len(rows)}"
    msg = rows[0]
    assert "move out clean in Wells" in msg.body
    assert "Recording:" in msg.body
    assert msg.subject == "Voicemail (0:42)"


def test_transcript_is_texted_to_the_on_call_phone(monkeypatch, twilio_token):
    """The payoff: the transcript arrives where she already looks."""
    sent = []
    # The voicemail forward now routes through services.sms_send.send_and_log,
    # which calls this seam — patch it so the send is captured and audited.
    monkeypatch.setattr("integrations.twilio_client.send_sms",
                        lambda **kw: sent.append(kw) or {"sid": "SM_t"})
    monkeypatch.setenv("VOICE_FORWARD_TO", "+12075559876")

    sid = "CAinbox-alert"
    _signed("/api/comms/twilio/voice/transcription", {
        "From": "+19783379583", "To": "+12075033301", "CallSid": sid,
        "RecordingUrl": "https://api.twilio.com/rec/RE2", "RecordingSid": "RE2",
        "TranscriptionStatus": "completed",
        "TranscriptionText": "Calling about a quote for a weekly cleaning.",
    })
    assert len(sent) == 1, sent
    assert sent[0]["to"] == "+12075559876"
    assert "weekly cleaning" in sent[0]["body"]


def test_hangup_with_no_recording_does_not_claim_a_voicemail(twilio_token):
    """A 0-second recording is a hang-up. Don't promise a message that isn't there."""
    sid = "CAinbox-hangup"
    common = {"From": "+14072694578", "To": "+12075033301", "CallSid": sid}
    _signed("/api/comms/twilio/voice/after-dial", {**common, "DialCallStatus": "no-answer"})
    _signed("/api/comms/twilio/voice/recording", {
        **common, "RecordingUrl": "", "RecordingDuration": "0", "RecordingStatus": "completed",
    })
    rows = _voice_rows(sid)
    assert len(rows) == 1
    assert "voicemail received" not in (rows[0].body or "").lower()
