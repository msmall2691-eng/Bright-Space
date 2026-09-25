"""integrations.twilio_client.send_sms — the destination gate.

Every outbound text in the app goes through this one function, and until now
it handed whatever string it was given straight to Twilio. Two real failures
came out of that, and both are pinned here:

  * a client record holding a typo'd 11-digit number was reshaped by
    `normalize_e164` into `+20743299492` and dialled;
  * a booking test used the company's own Twilio number as the customer's
    phone, and Twilio answered "'To' and 'From' number cannot be the same".

The gate must refuse both BEFORE the HTTP call, must not disturb the numbers
that were always fine, and must normalise what it does send — the quote path
was passing "(207) 432-9492" and getting away with it on Twilio's goodwill.
"""
from unittest.mock import MagicMock, patch

import pytest

from integrations import twilio_client

FROM_NUMBER = "+12075033301"


@pytest.fixture
def configured(monkeypatch):
    """Credentials present, so the only thing that can reject a send is the
    gate itself rather than the config guards above it."""
    monkeypatch.setattr(twilio_client, "_TWILIO_ACCOUNT_SID", "AC" + "0" * 30)
    monkeypatch.setattr(twilio_client, "_TWILIO_AUTH_TOKEN", "token")
    monkeypatch.setattr(twilio_client, "_TWILIO_PHONE_NUMBER", FROM_NUMBER)


@pytest.fixture
def twilio(configured):
    """A stand-in Twilio client. Asserting on `.messages.create` is how we
    prove a refusal happened BEFORE the network call, not after it."""
    msg = MagicMock(sid="SM" + "f" * 30, status="queued")
    client = MagicMock()
    client.messages.create.return_value = msg
    with patch.object(twilio_client, "_client", return_value=client):
        yield client


# --- the two failures that actually happened -------------------------------

def test_the_mistyped_eleven_digit_number_is_never_dialled(twilio):
    """`+1 20743299492` — one digit too many, a real client record. The old
    path reshaped it to a +-prefixed 12-digit string and let Twilio 400 it."""
    with pytest.raises(ValueError) as e:
        twilio_client.send_sms(to="+1 20743299492", body="hi")
    assert "not a textable" in str(e.value)
    twilio.messages.create.assert_not_called()


def test_texting_our_own_twilio_number_is_refused_with_a_readable_reason(twilio):
    """The booking-test failure. Twilio's own 400 for this is accurate and
    unreadable; the point of catching it here is the sentence, not the save."""
    with pytest.raises(ValueError) as e:
        twilio_client.send_sms(to="207-503-3301", body="hi")
    assert "own Twilio number" in str(e.value)
    twilio.messages.create.assert_not_called()


def test_the_self_send_check_sees_through_formatting(twilio):
    """Same line, written the way a human types it. A string comparison
    against the configured number would miss every one of these."""
    for spelling in ("+12075033301", "(207) 503-3301", "207.503.3301",
                     "12075033301", "  +1 207 503 3301  "):
        with pytest.raises(ValueError) as e:
            twilio_client.send_sms(to=spelling, body="hi")
        assert "own Twilio number" in str(e.value), spelling
    twilio.messages.create.assert_not_called()


# --- what must still get through -------------------------------------------

def test_an_ordinary_number_still_sends(twilio):
    out = twilio_client.send_sms(to="+12074329492", body="hi")
    assert out == {"sid": "SM" + "f" * 30, "status": "queued"}
    twilio.messages.create.assert_called_once()
    assert twilio.messages.create.call_args.kwargs["to"] == "+12074329492"
    assert twilio.messages.create.call_args.kwargs["from_"] == FROM_NUMBER


@pytest.mark.parametrize("spelling", [
    "(207) 432-9492", "207-432-9492", "207.432.9492", "2074329492",
    "12074329492", "+1 (207) 432-9492",
])
def test_human_formatting_is_normalised_before_it_reaches_twilio(twilio, spelling):
    """These all worked before — by luck, because Twilio is lenient about
    formatting. Now they work because we normalise them."""
    twilio_client.send_sms(to=spelling, body="hi")
    assert twilio.messages.create.call_args.kwargs["to"] == "+12074329492"


def test_a_canadian_number_is_in_the_plan_and_allowed(twilio):
    twilio_client.send_sms(to="+14165551234", body="hi")
    assert twilio.messages.create.call_args.kwargs["to"] == "+14165551234"


# --- the expensive destinations --------------------------------------------

@pytest.mark.parametrize("bad,why", [
    ("+447700900123", "a UK mobile — a foreign number, billed at foreign rates"),
    ("+19005551234", "900: premium-rate, billed to the caller"),
    ("+15005551234", "500: personal communications, forwards anywhere"),
    ("+17005551234", "700: carrier-specific, not a customer's phone"),
    ("+12079765555", "976 exchange: the other premium-rate range"),
    ("+14115551234", "411: a service code, not a subscriber"),
    ("+19115551234", "911: emphatically not a destination for a quote"),
    ("+11115551234", "area code cannot start with 1"),
    ("+12070115555", "exchange cannot start with 0"),
])
def test_destinations_outside_the_plan_are_refused(twilio, bad, why):
    with pytest.raises(ValueError):
        twilio_client.send_sms(to=bad, body="hi")
    twilio.messages.create.assert_not_called(), why


@pytest.mark.parametrize("junk", ["", "   ", "not a phone", "555", None])
def test_junk_destinations_are_refused(twilio, junk):
    with pytest.raises(ValueError):
        twilio_client.send_sms(to=junk, body="hi")
    twilio.messages.create.assert_not_called()


# --- the refusal must not be mistaken for an outage ------------------------

def test_a_refusal_raises_before_the_configuration_guards_are_satisfied():
    """With no credentials at all, the config error still wins — a refusal
    must not mask "Twilio isn't set up", which is a different fix."""
    with patch.object(twilio_client, "_TWILIO_PHONE_NUMBER", None):
        with pytest.raises(ValueError) as e:
            twilio_client.send_sms(to="+12074329492", body="hi")
        assert "not configured" in str(e.value)


def test_a_provider_failure_is_still_a_runtime_error_not_a_value_error(twilio):
    """Callers distinguish "we refused" (ValueError) from "Twilio broke"
    (RuntimeError). Adding the gate must not blur that line."""
    twilio.messages.create.side_effect = Exception("boom")
    with pytest.raises(RuntimeError) as e:
        twilio_client.send_sms(to="+12074329492", body="hi")
    assert "Twilio API error" in str(e.value)


# --- the validator itself keeps its old identity ---------------------------

def test_sms_guard_still_exposes_the_same_rule():
    """`nanp_number` moved to utils.phone but the booking path and its tests
    import it from services.sms_guard. The alias must stay honest."""
    from services import sms_guard
    from utils.phone import nanp_e164
    for raw in ("207-432-9492", "+447700900123", "+19005551234", "", None,
                "+1 20743299492", "2074329492"):
        assert sms_guard.nanp_number(raw) == nanp_e164(raw), raw
