"""Google Calendar notification + reminder controls.

Covers the two new Settings knobs and the reschedule-keeps-the-customer fix:
- gcal_reminders_mode → the reminders block on the event
- notify_customers → whether Google emails the customer
- _build_event keeps the customer as an attendee (so a reschedule doesn't drop
  their invite) and honors the passed reminders block.
"""
import modules.settings.router as sr
from integrations.google_calendar import _build_event


_JOB = {"id": 1, "title": "Biweekly clean", "job_type": "residential",
        "scheduled_date": "2026-08-15", "start_time": "10:00", "end_time": "13:00",
        "address": "4 Balsam Drive, Waterboro, ME", "notes": "gate code 1234"}
_CLIENT = {"id": 7, "name": "Ben Stackhouse", "email": "ben@example.com"}


def test_reminder_modes(monkeypatch):
    def mode(v):
        monkeypatch.setattr(sr, "get_setting", lambda db, k: v)
        return sr.gcal_reminder_overrides(None)
    assert mode(None) == {"useDefault": True}            # default → Google's own
    assert mode("google_default") == {"useDefault": True}
    assert mode("off") == {"useDefault": False, "overrides": []}
    ep = mode("email_popup")
    assert ep["useDefault"] is False and len(ep["overrides"]) == 2
    # Unknown value falls back to Google default, never crashes.
    assert mode("garbage") == {"useDefault": True}


def test_notify_customers_default_on(monkeypatch):
    monkeypatch.setattr(sr, "get_setting", lambda db, k: None)
    assert sr.customer_notify_enabled(None) is True
    monkeypatch.setattr(sr, "get_setting", lambda db, k: "false")
    assert sr.customer_notify_enabled(None) is False


def test_build_event_keeps_customer_attendee_on_reschedule():
    # The reschedule path passes include_attendees=True; the customer must stay
    # on the attendee list so their invite updates instead of vanishing.
    ev = _build_event(_JOB, _CLIENT, include_attendees=True, reminders={"useDefault": True})
    emails = [a["email"] for a in ev.get("attendees", [])]
    assert "ben@example.com" in emails
    assert ev["reminders"] == {"useDefault": True}
    # Customer-facing event must NOT leak the gate code.
    assert "1234" not in ev["description"]


def test_build_event_reminders_off():
    ev = _build_event(_JOB, _CLIENT, reminders={"useDefault": False, "overrides": []})
    assert ev["reminders"] == {"useDefault": False, "overrides": []}


def test_build_event_default_reminders_when_none():
    # Legacy callers that pass no reminders keep the old email-24h + popup-1h.
    ev = _build_event(_JOB, _CLIENT)
    assert ev["reminders"]["useDefault"] is False
    assert any(o["method"] == "email" for o in ev["reminders"]["overrides"])
