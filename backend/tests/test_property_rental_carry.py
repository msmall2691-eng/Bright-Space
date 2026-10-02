"""Rental request data must survive conversion onto the Property, instead of
being dropped. Covers modules.intake.details.fill_property_rental_from_intake
and its time parser — the counterpart to fill_property_access_from_intake for
STR (vacation-rental) fields (check-in/out times, guests, listing URL, turnover
day). Pure/duck-typed: no DB needed."""
from types import SimpleNamespace

import pytest

from modules.intake.details import _coerce_hhmm, fill_property_rental_from_intake


def _prop(**kw):
    base = dict(property_type="str", check_in_time=None, check_out_time=None, custom_fields=None)
    base.update(kw)
    return SimpleNamespace(**base)


def _intake(**kw):
    base = dict(check_in=None, check_out=None, guests=None, custom_fields=None)
    base.update(kw)
    return SimpleNamespace(**base)


@pytest.mark.parametrize("raw,expected", [
    ("14:00", "14:00"), ("9:00", "09:00"), ("09:00", "09:00"),
    ("3pm", "15:00"), ("3 PM", "15:00"), ("3:00 PM", "15:00"),
    ("11am", "11:00"), ("11 AM", "11:00"), ("12am", "00:00"), ("12pm", "12:00"),
    ("9", "09:00"),
])
def test_coerce_hhmm_parses_common_times(raw, expected):
    assert _coerce_hhmm(raw) == expected


@pytest.mark.parametrize("raw", ["flexible", "2026-07-07", "10-11am", "noon", "", None, "25:00", "9:99"])
def test_coerce_hhmm_returns_none_for_unparseable(raw):
    assert _coerce_hhmm(raw) is None


def test_carries_times_guests_and_essentials_onto_str_property():
    prop = _prop()
    intake = _intake(check_in="3pm", check_out="11am", guests=6,
                     custom_fields={"listing_url": "https://airbnb.com/h/x", "turnover_day": "Saturday"})
    changed = fill_property_rental_from_intake(prop, intake)
    assert changed is True
    assert prop.check_in_time == "15:00"
    assert prop.check_out_time == "11:00"
    assert prop.custom_fields["guests"] == 6
    assert prop.custom_fields["listing_url"] == "https://airbnb.com/h/x"
    assert prop.custom_fields["turnover_day"] == "Saturday"


def test_noop_for_non_str_property():
    prop = _prop(property_type="residential")
    intake = _intake(check_in="3pm", check_out="11am", guests=4)
    assert fill_property_rental_from_intake(prop, intake) is False
    assert prop.check_in_time is None
    assert prop.check_out_time is None
    assert not prop.custom_fields


def test_fill_if_missing_never_overwrites_an_existing_time():
    prop = _prop(check_in_time="14:00")           # operator already set it
    intake = _intake(check_in="3pm", check_out="11am")
    fill_property_rental_from_intake(prop, intake)
    assert prop.check_in_time == "14:00"          # kept
    assert prop.check_out_time == "11:00"         # the empty one got filled


def test_unparseable_time_is_preserved_raw_not_lost():
    prop = _prop()
    intake = _intake(check_in="flexible / ask host")
    fill_property_rental_from_intake(prop, intake)
    # Never written to the strict HH:MM column…
    assert prop.check_in_time is None
    # …but kept on custom_fields so the operator still sees what the customer said.
    assert prop.custom_fields["check_in"] == "flexible / ask host"


def test_existing_custom_fields_keys_are_not_clobbered():
    prop = _prop(custom_fields={"listing_url": "https://keep.me", "photos": ["a"]})
    intake = _intake(custom_fields={"listing_url": "https://new.example", "turnover_day": "Sun"})
    fill_property_rental_from_intake(prop, intake)
    assert prop.custom_fields["listing_url"] == "https://keep.me"   # not overwritten
    assert prop.custom_fields["turnover_day"] == "Sun"              # added
    assert prop.custom_fields["photos"] == ["a"]                    # untouched


def test_no_rental_data_is_a_clean_noop():
    prop = _prop()
    intake = _intake()
    assert fill_property_rental_from_intake(prop, intake) is False
    assert prop.check_in_time is None and not prop.custom_fields


def test_conversion_wires_rental_carry_end_to_end():
    """The wiring, not just the helper: converting a real STR request to a
    client+property must land the check-in/out times and essentials on the
    Property (this is the path that was dropping them)."""
    from database.db import SessionLocal
    from database.models import Client, LeadIntake, Property
    from modules.intake.router import _resolve_property_for_intake

    db = SessionLocal()
    try:
        client = Client(name="Cottage Owner", email="cottage@example.com", status="lead")
        db.add(client); db.commit(); db.refresh(client)
        intake = LeadIntake(
            name="Cottage Owner", email="cottage@example.com",
            address="9 Shore Rd", city="Camden", state="ME", zip_code="04843",
            service_type="str", source="website", status="new",
            check_in="3pm", check_out="11am", guests=5,
            custom_fields={"listing_url": "https://airbnb.com/h/cottage", "turnover_day": "Saturday"},
        )
        db.add(intake); db.commit(); db.refresh(intake)

        prop = _resolve_property_for_intake(db, client, intake)
        db.commit(); db.refresh(prop)

        assert prop.property_type == "str"
        assert prop.check_in_time == "15:00"
        assert prop.check_out_time == "11:00"
        assert (prop.custom_fields or {}).get("guests") == 5
        assert (prop.custom_fields or {}).get("listing_url") == "https://airbnb.com/h/cottage"
        assert (prop.custom_fields or {}).get("turnover_day") == "Saturday"
    finally:
        cids = [c.id for c in db.query(Client).filter(Client.email == "cottage@example.com").all()]
        if cids:
            db.query(Property).filter(Property.client_id.in_(cids)).delete(synchronize_session=False)
        db.query(LeadIntake).filter(LeadIntake.email == "cottage@example.com").delete(synchronize_session=False)
        db.query(Client).filter(Client.email == "cottage@example.com").delete(synchronize_session=False)
        db.commit(); db.close()
