"""BB-CREW-02: the marketplace's own messages fall back to SMS.

"You got the job", "someone else got it", "a job you'd agreed changed hands",
and "the job you asked for came off the board" went out on push ONLY. Web push
needs the app installed to the home screen and notifications allowed — a chain
a busy independent cleaner has little reason to have finished — so the person a
decision most affects was often the one who never heard it.

`crew_notify.notify_user_or_sms` is the single-recipient twin of the offer's
two-channel path: push first, and SMS to that ONE person only when push reached
nobody, only if the category isn't muted, and only if a number is on file. It
is a FALLBACK, never a second copy, and it must not defeat the opt-out.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import User
from services import crew_notify


@pytest.fixture
def user_factory():
    db = SessionLocal()
    made = []

    def make(*, phone="207-555-0142", prefs=None):
        cid = f"crew-{uuid.uuid4().hex[:6]}"
        u = User(email=f"{cid}@example.com", role="cleaner", cleaner_id=cid,
                 org_id=1, phone=phone, notification_prefs=prefs)
        db.add(u); db.commit(); db.refresh(u)
        made.append(u.id)
        return u

    yield make
    db.query(User).filter(User.id.in_(made or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture
def wire(monkeypatch):
    """Control push's return and record every SMS the helper sends."""
    calls = {"push": [], "sms": []}

    def push(user_id, title, body, *, url="/", tag=None, category=None):
        calls["push"].append({"user_id": user_id, "category": category})
        return calls["push_returns"]

    def send_sms(to, body):
        calls["sms"].append({"to": to, "body": body})
        return {"sid": "SM_test"}

    calls["push_returns"] = 0
    monkeypatch.setattr("services.push_service.notify_user", push)
    monkeypatch.setattr("integrations.twilio_client.send_sms", send_sms)
    monkeypatch.setattr("integrations.twilio_client.configured", lambda: True)
    return calls


def test_sms_when_push_reached_nobody(user_factory, wire):
    u = user_factory(phone="207-555-0142")
    wire["push_returns"] = 0                     # push reached no device

    n = crew_notify.notify_user_or_sms(
        u.id, "You got the job!", "Maple Cottage is yours.",
        category="job_assignments")

    assert n == 1
    assert len(wire["sms"]) == 1
    assert wire["sms"][0]["to"] == "+12075550142"
    assert "Maple Cottage" in wire["sms"][0]["body"]


def test_no_sms_when_push_delivered(user_factory, wire):
    u = user_factory(phone="207-555-0142")
    wire["push_returns"] = 2                      # two devices got the push

    n = crew_notify.notify_user_or_sms(
        u.id, "You got the job!", "Maple Cottage is yours.",
        category="job_assignments")

    assert n == 2                                 # push count, not a second copy
    assert wire["sms"] == []                      # never texted


def test_muted_category_is_not_texted(user_factory, wire):
    # Push returns 0 both when it reached nobody AND when the category is muted;
    # the fallback re-checks the mute so it doesn't text the exact people who
    # asked not to hear this.
    u = user_factory(phone="207-555-0142", prefs={"open_jobs": False})
    wire["push_returns"] = 0

    n = crew_notify.notify_user_or_sms(
        u.id, "That job is off the board", "It was cancelled.",
        category="open_jobs")

    assert n == 0
    assert wire["sms"] == []


def test_no_phone_no_sms(user_factory, wire):
    u = user_factory(phone=None)
    wire["push_returns"] = 0

    n = crew_notify.notify_user_or_sms(
        u.id, "A job changed hands", "Nothing else of yours is affected.",
        category="open_jobs")

    assert n == 0
    assert wire["sms"] == []


def test_sms_not_configured_is_a_quiet_noop(user_factory, wire, monkeypatch):
    monkeypatch.setattr("integrations.twilio_client.configured", lambda: False)
    u = user_factory(phone="207-555-0142")
    wire["push_returns"] = 0

    n = crew_notify.notify_user_or_sms(
        u.id, "You got the job!", "Maple Cottage is yours.",
        category="job_assignments")

    assert n == 0
    assert wire["sms"] == []


def test_custom_sms_body_overrides_the_push_text(user_factory, wire):
    u = user_factory(phone="207-555-0142")
    wire["push_returns"] = 0

    crew_notify.notify_user_or_sms(
        u.id, "You got the job!", "Maple Cottage is yours.",
        category="job_assignments", sms_body="You won a job — open the app.")

    assert wire["sms"][0]["body"] == "You won a job — open the app."
