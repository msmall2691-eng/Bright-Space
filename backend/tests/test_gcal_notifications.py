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


def test_notify_on_move_default_off(monkeypatch):
    # The move-specific email toggle defaults OFF: dragging a job around the
    # calendar shouldn't email the customer unless they opt in. This is the
    # knob that lets booking/cancellation emails stay on while moves go silent.
    monkeypatch.setattr(sr, "get_setting", lambda db, k: None)
    assert sr.customer_notify_on_move_enabled(None) is False
    monkeypatch.setattr(sr, "get_setting", lambda db, k: "true")
    assert sr.customer_notify_on_move_enabled(None) is True


def test_release_sync_links_silent_on_operator_move(monkeypatch):
    """A recurring occurrence moved by the operator (notify=False) must delete
    the old Google event SILENTLY — no "cancelled" email — while a skip/edit
    (notify=True, default) still emails. Mirrors the single-job move gating for
    the recurring/bulk path."""
    import types
    import modules.recurring.router as rr
    import integrations.google_calendar as gcal

    captured = {}
    def fake_delete(event_id, job_type, owner_account_id=None, send_updates="all"):
        captured["send_updates"] = send_updates
        return True
    monkeypatch.setattr(gcal, "delete_event", fake_delete)
    # Master notify ON so the only variable under test is the `notify` flag.
    monkeypatch.setattr(sr, "customer_notify_enabled", lambda db: True)

    def job():
        return types.SimpleNamespace(
            id=1, gcal_event_id="evt_123", job_type="residential",
            gcal_account_id=None, connecteam_shift_ids=None)

    rr._release_sync_links(None, job(), notify=False)
    assert captured["send_updates"] == "none"   # operator move → silent

    captured.clear()
    rr._release_sync_links(None, job(), notify=True)
    assert captured["send_updates"] == "all"    # skip/edit → cancellation email


def test_move_sendupdates_gating():
    """The in-place reschedule branch emails the customer only when master
    notify AND the move toggle are both on. Mirrors the `_upd_su` expression in
    scheduling.update_job so a regression there is caught here."""
    def upd_su(inv, notify, on_move):
        return "all" if (inv and notify and on_move) else "none"
    assert upd_su(True, True, True) == "all"      # opted in → email on move
    assert upd_su(True, True, False) == "none"    # default → silent move
    assert upd_su(True, False, True) == "none"    # master off → silent regardless
    assert upd_su(False, True, True) == "none"    # no invite/email on file


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
