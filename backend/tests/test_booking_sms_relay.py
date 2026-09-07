"""`POST /api/booking/submit` must not be an SMS relay.

WHAT IT WAS. The endpoint is public and unauthenticated by design — it is the
maineclean.co booking form. It took the SMS destination straight off the
request body and appended `data.manageUrl` to the message verbatim:

    to_number = (data.phone or "").strip()
    body += f" Manage/cancel: {data.manageUrl}"

So anyone on the internet could send a text FROM The Maine Cleaning Co.'s
Twilio number, TO any number on earth, carrying their own link. Three real
costs: international and premium-rate toll fraud billed to the account, an A2P
violation that gets the number suspended, and phishing traceable to the
business's sender ID. The only brake was 20/hour per IP.

The irony this file preserves: the code already said "NEVER log `body` — it
can carry the capability-token manage URL." Somebody thought hard about the
message and not at all about the destination.

WHAT IS PINNED. The destination restriction is the load-bearing one — it makes
toll fraud impossible rather than merely expensive — but each limit is tested
alone, because any one of them by itself is bypassable.
"""
import itertools
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import IntegrationEvent
from services import sms_guard

client = TestClient(app)


_next_line = itertools.count(1000)


def _a_number() -> str:
    """A fresh, valid Maine number for each submission."""
    return f"207-555-{next(_next_line) % 10000:04d}"


def _body(**over):
    """A DISTINCT lead each time. Name and address are both randomised because
    intake dedups on name+address within 24h — leave them fixed and every
    submission after the first collapses onto one row, takes the deduped
    early-return, and sends nothing, which would make most of this file pass
    for entirely the wrong reason."""
    tag = uuid.uuid4().hex[:8]
    b = {"name": f"Dana {tag}", "email": f"dana-{tag}@example.com",
         # A distinct number too: the per-destination cap is 3, so a shared
         # default phone would quietly cap tests that are about something else.
         "phone": _a_number(), "address": f"{tag} Elm St, Portland ME",
         "serviceType": "standard", "requestedDate": "2026-10-02",
         "bedrooms": 3, "bathrooms": 2}
    b.update(over)
    return b


@pytest.fixture(autouse=True)
def _twilio(monkeypatch):
    """Configured Twilio, captured rather than sent.

    The per-IP limiter is switched off here on purpose: every request in this
    file comes from the same TestClient address, and 20/hour would stop the
    tests long before the limits under test. That limiter is exactly what
    these fixes exist to stop relying on — an attacker rotating IPs is not
    slowed by it at all.
    """
    from ratelimit import limiter
    monkeypatch.setattr(limiter, "enabled", False, raising=False)
    from integrations import twilio_client
    monkeypatch.setattr(twilio_client, "_TWILIO_ACCOUNT_SID", "AC_test", raising=False)
    monkeypatch.setattr(twilio_client, "_TWILIO_AUTH_TOKEN", "tok", raising=False)
    monkeypatch.setattr(twilio_client, "_TWILIO_PHONE_NUMBER", "+12070000000", raising=False)
    sent = []
    monkeypatch.setattr(twilio_client, "send_sms",
                        lambda to, body: (sent.append({"to": to, "body": body}),
                                          {"sid": "SM1", "status": "queued"})[1])
    yield sent
    db = SessionLocal()
    db.query(IntegrationEvent).filter(
        IntegrationEvent.action == sms_guard.ACTION).delete(synchronize_session=False)
    db.commit(); db.close()


def _submit(**over):
    r = client.post("/api/booking/submit", json=_body(**over))
    assert r.status_code in (200, 201), r.text
    return r


# ── the destination ────────────────────────────────────────────────────────

@pytest.mark.parametrize("phone", [
    "+447700900123",     # UK
    "+8801700000000",    # Bangladesh — the classic toll-fraud destination
    "+61491570156",      # Australia
    "+1900555 0134",     # US premium rate: N11-style / invalid area code
    "911",
    "+19115550134",
])
def test_it_will_not_text_a_number_outside_north_america(_twilio, phone):
    """The limit that makes toll fraud impossible rather than expensive: these
    destinations are not rate-limited, they are unreachable."""
    _submit(phone=phone)
    assert _twilio == [], f"sent to {phone}"


def test_it_still_texts_a_real_customer(_twilio):
    _submit(phone="(207) 555-0134")
    assert len(_twilio) == 1
    assert _twilio[0]["to"] == "+12075550134"


# ── the message ────────────────────────────────────────────────────────────

def test_a_link_to_somewhere_we_do_not_own_never_reaches_the_message(_twilio):
    """An arbitrary URL sent from the company's number is phishing with our
    sender ID on it. The booking still goes through — it just goes without
    the link."""
    _submit(manageUrl="https://evil.example/steal")
    assert len(_twilio) == 1
    assert "evil.example" not in _twilio[0]["body"]
    assert "Manage/cancel" not in _twilio[0]["body"]


def test_our_own_manage_link_still_rides(_twilio):
    _submit(manageUrl="https://maineclean.co/booking/abc123")
    assert "https://maineclean.co/booking/abc123" in _twilio[0]["body"]


def test_userinfo_cannot_dress_a_link_up_as_somebody_else(_twilio):
    """`https://evil.co@maineclean.co/x` really does load our host, so a host
    check passes it — but the person reading the text sees "evil.co", which is
    the whole trick."""
    _submit(manageUrl="https://evil.co@maineclean.co/x")
    assert "evil.co" not in _twilio[0]["body"]


def test_the_name_cannot_smuggle_text_into_the_message(_twilio):
    """The greeting is the last caller-supplied text in the body."""
    _submit(name=f"Meg https://evil.example/x {uuid.uuid4().hex[:6]}")
    body = _twilio[0]["body"]
    assert "evil.example" not in body and "https" not in body.split("Manage")[0]


def test_an_unknown_service_does_not_become_free_text(_twilio):
    """`service_label` titlecases an unrecognised key, which is caller input
    in a message sent from our number."""
    _submit(serviceType="CALL 1-900-555-0199 NOW")
    assert "1-900" not in _twilio[0]["body"]


# ── the budget ─────────────────────────────────────────────────────────────

def test_one_number_cannot_be_texted_all_day():
    """Per-destination cap: an attacker rotating IPs past the per-IP limiter
    must not turn the number into a spam cannon aimed at one person.

    Tested against `may_send` directly rather than through the endpoint,
    because intake dedups on phone — repeat submissions to one number collapse
    onto a single lead and never reach the SMS path, so an endpoint test here
    would pass without the cap existing at all.
    """
    db = SessionLocal()
    to = "+12075550176"
    try:
        for i in range(sms_guard.DAILY_PER_NUMBER_CAP):
            assert sms_guard.may_send(db, to)[0] is True, f"refused at {i}"
            sms_guard.record_send(db, to_number=to, intake_id=1, sid=f"SM{i}")
        allowed, why = sms_guard.may_send(db, to)
        assert allowed is False and why == "per-number cap"
        # A DIFFERENT number is unaffected — this is a per-destination cap.
        assert sms_guard.may_send(db, "+12075550175")[0] is True
    finally:
        db.close()


def test_the_account_has_a_daily_ceiling(monkeypatch):
    """A ceiling on the damage, not a business limit — crossing it means
    something is wrong rather than busy."""
    monkeypatch.setattr(sms_guard, "DAILY_ACCOUNT_CAP", 3)
    monkeypatch.setattr(sms_guard, "DAILY_PER_NUMBER_CAP", 99)
    db = SessionLocal()
    try:
        for i in range(3):
            assert sms_guard.may_send(db, f"+1207555{i:04d}")[0] is True
            sms_guard.record_send(db, to_number=f"+1207555{i:04d}", intake_id=1, sid=f"S{i}")
        allowed, why = sms_guard.may_send(db, "+12075559999")
        assert allowed is False and why == "daily account cap"
    finally:
        db.close()


def test_every_send_is_recorded(_twilio):
    """The booking SMS was logged nowhere at all, so there was no record of
    what the number had sent and nothing to count a budget against."""
    _submit(phone="207-555-0143")
    db = SessionLocal()
    rows = db.query(IntegrationEvent).filter(
        IntegrationEvent.action == sms_guard.ACTION).all()
    payloads = [r.request_payload for r in rows]
    db.close()
    assert payloads == ["to +12075550143"]


# ── the amplifier ──────────────────────────────────────────────────────────

def test_a_repeat_submission_does_not_re_alert_everyone(_twilio):
    """`build_intake` collapses repeat posts into ONE lead row, but every
    notification fired anyway — so 20 requests inside the hourly limit meant
    20 pages to the owner's phone for one lead. The alerts follow the row."""
    body = _body(phone="207-555-0199")
    first = client.post("/api/booking/submit", json=body)
    assert first.status_code in (200, 201), first.text
    for _ in range(4):
        again = client.post("/api/booking/submit", json=body)
        assert again.status_code in (200, 201)
        assert again.json()["bookingId"] == first.json()["bookingId"], "not deduped"
    assert len(_twilio) == 1
