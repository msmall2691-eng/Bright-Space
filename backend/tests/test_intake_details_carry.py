"""A request's on-site details carry onto the records the crew reads.

The six booking essentials (entry method, parking, pets, focus areas, special
instructions, arrival window) used to live only in LeadIntake.custom_fields and
reached the crew nowhere. Now, on conversion:
  * place-stable details (entry method, parking, pets) fill the Property's
    access fields — fill-if-missing, so an operator's edits are never clobbered;
  * per-visit details (focus areas, special instructions, arrival window) are
    appended to the Job's notes, which the crew job card shows.
"""
from types import SimpleNamespace

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Quote, Job, LeadIntake
from modules.intake.details import (
    fill_property_access_from_intake, compose_job_notes_from_intake,
)
from modules.quoting.router import _convert_quote_to_job


_ESSENTIALS = {
    "entry_method": "lockbox",
    "parking_notes": "Driveway only, do not block the garage",
    "pets_detail": "Two cats, keep the back door shut",
    "focus_areas": ["kitchen", "bathrooms"],
    "special_instructions": "Please use fragrance-free products",
    "arrival_window": "morning",
}


# --- unit: the helpers -------------------------------------------------------

def test_fill_property_access_composes_and_fills_empty_fields():
    prop = SimpleNamespace(parking_notes=None, access_notes=None)
    changed = fill_property_access_from_intake(prop, SimpleNamespace(custom_fields=_ESSENTIALS))
    assert changed is True
    assert prop.parking_notes == "Driveway only, do not block the garage"
    assert prop.access_notes == "Entry: lockbox · Pets: Two cats, keep the back door shut"


def test_fill_property_access_is_fill_if_missing():
    # An operator's existing values must never be overwritten.
    prop = SimpleNamespace(parking_notes="Street parking", access_notes="Use side door")
    changed = fill_property_access_from_intake(prop, SimpleNamespace(custom_fields=_ESSENTIALS))
    assert changed is False
    assert prop.parking_notes == "Street parking"
    assert prop.access_notes == "Use side door"


def test_fill_property_access_no_essentials_is_noop():
    prop = SimpleNamespace(parking_notes=None, access_notes=None)
    assert fill_property_access_from_intake(prop, SimpleNamespace(custom_fields={})) is False
    assert fill_property_access_from_intake(prop, None) is False
    assert prop.parking_notes is None and prop.access_notes is None


def test_compose_job_notes_appends_per_visit_details():
    out = compose_job_notes_from_intake("Gate is sticky", SimpleNamespace(custom_fields=_ESSENTIALS))
    assert out.startswith("Gate is sticky")
    assert "Focus: Kitchen, Bathrooms" in out
    assert "Special instructions: Please use fragrance-free products" in out
    assert "Arrival window: morning" in out


def test_compose_job_notes_is_idempotent_and_handles_empty():
    once = compose_job_notes_from_intake("base", SimpleNamespace(custom_fields=_ESSENTIALS))
    twice = compose_job_notes_from_intake(once, SimpleNamespace(custom_fields=_ESSENTIALS))
    assert once == twice, "re-composing must not duplicate the block"
    assert compose_job_notes_from_intake("just notes", SimpleNamespace(custom_fields={})) == "just notes"
    assert compose_job_notes_from_intake(None, None) == ""


# --- integration: through the real quote -> job conversion -------------------

@pytest.fixture
def convert_ctx():
    db = SessionLocal()
    c = Client(name="Carry Test", email="carry@example.com", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    prop = Property(client_id=c.id, org_id=1, name="12 Dock", address="12 Dock Rd",
                    property_type="residential", active=True)
    db.add(prop); db.commit(); db.refresh(prop)
    intake = LeadIntake(name="Carry Test", email="carry@example.com",
                        custom_fields=dict(_ESSENTIALS), org_id=1)
    db.add(intake); db.commit(); db.refresh(intake)
    yield db, c, prop, intake
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id == intake.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_quote(db, client_id, property_id, intake_id, notes="Gate is sticky"):
    q = Quote(client_id=client_id, quote_number=f"QT-{intake_id}", title="T",
              service_type="residential", address="12 Dock Rd", notes=notes, items=[],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100,
              status="accepted", property_id=property_id, intake_id=intake_id, org_id=1)
    db.add(q); db.commit(); db.refresh(q)
    return q


def test_conversion_carries_essentials_to_property_and_job(convert_ctx):
    db, c, prop, intake = convert_ctx
    q = _mk_quote(db, c.id, prop.id, intake.id)
    job = _convert_quote_to_job(db, q)

    # Per-visit details reached the job notes (which the crew card shows).
    assert "Focus: Kitchen, Bathrooms" in (job.notes or "")
    assert "Special instructions: Please use fragrance-free products" in (job.notes or "")
    assert "Arrival window: morning" in (job.notes or "")
    assert (job.notes or "").startswith("Gate is sticky")

    # Place-stable details reached the property's access fields.
    db.refresh(prop)
    assert prop.parking_notes == "Driveway only, do not block the garage"
    assert prop.access_notes == "Entry: lockbox · Pets: Two cats, keep the back door shut"


def test_conversion_does_not_overwrite_operator_property_edits(convert_ctx):
    db, c, prop, intake = convert_ctx
    prop.access_notes = "Key is with the neighbor at #10"
    prop.parking_notes = "Guest lot around back"
    db.commit()

    q = _mk_quote(db, c.id, prop.id, intake.id)
    _convert_quote_to_job(db, q)

    db.refresh(prop)
    assert prop.access_notes == "Key is with the neighbor at #10"
    assert prop.parking_notes == "Guest lot around back"
