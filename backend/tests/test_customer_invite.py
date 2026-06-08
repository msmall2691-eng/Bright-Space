"""Inviting the customer to their cleaning must (a) add them as an attendee and
(b) NOT leak on-site secrets (gate codes, internal notes, crew) into the event
they receive. The internal (owner/crew) event keeps the full detail.
"""
from integrations.google_calendar import _build_event


JOB = {
    "id": 1, "title": "Smith Residence — Clean", "job_type": "residential",
    "scheduled_date": "2026-06-30", "start_time": "10:00", "end_time": "12:00",
    "address": "1 Main St, Portland ME", "notes": "Dog in the yard — internal note",
}
CLIENT = {"id": 5, "name": "Pat Smith", "email": "pat@example.com"}
PROP = {"house_code": "4251", "access_notes": "Side door lockbox", "parking_notes": "Driveway"}


def test_customer_event_is_clean_and_invites_them():
    e = _build_event(JOB, CLIENT, include_attendees=True, property_data=PROP)
    desc = e["description"]
    # Customer is invited
    assert any(a.get("email") == "pat@example.com" for a in e.get("attendees", []))
    # No on-site secrets / internal notes leak to the customer
    assert "4251" not in desc
    assert "lockbox" not in desc.lower()
    assert "internal note" not in desc.lower()
    assert "Crew" not in desc
    # But it's still useful
    assert "1 Main St, Portland ME" in desc
    assert "Maine Cleaning Co" in desc


def test_internal_event_keeps_full_detail_and_no_attendee():
    e = _build_event(JOB, CLIENT, include_attendees=False, property_data=PROP)
    desc = e["description"]
    assert "4251" in desc                      # access code present for the crew/owner
    assert "internal note" in desc.lower()     # notes present internally
    assert "attendees" not in e                # customer NOT invited
