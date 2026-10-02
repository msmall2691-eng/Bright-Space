"""Duplicate properties can be merged losslessly and org-scoped — parity with
the client merge.

POST /api/cleanup/properties/merge folds a duplicate property into a keeper:
re-parents every property-scoped record (jobs, recurring schedules, quotes, lead
intakes, iCal feeds + events, crew notes, photos), back-fills the keeper's
missing fields (full set, not just size), then deletes the duplicate. It refuses
a cross-client merge, and refuses (rather than auto-cancelling a job) when the
two properties have overlapping live turnover jobs on the same date.
"""
from datetime import date, time

import pytest

from database.db import SessionLocal
from database.models import (
    Client, Property, Job, RecurringSchedule, Quote, LeadIntake,
    PropertyIcal, ICalEvent, PropertyCrewNote, PropertyPhoto,
)
from modules.cleanup.router import merge_properties, MergePropertiesBody


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Merge Props", email="mp@example.com", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    keeper = Property(client_id=c.id, org_id=1, name="12 Dock", address="12 Dock Rd",
                      property_type="residential", active=True)
    dup = Property(client_id=c.id, org_id=1, name="12 Dock Rd", address="12 Dock Rd",
                   property_type="residential", active=True)
    db.add_all([keeper, dup]); db.commit(); db.refresh(keeper); db.refresh(dup)
    created = {"clients": [c.id], "props": [keeper.id, dup.id]}
    yield db, c, keeper, dup, created
    db.rollback()
    pids = created["props"]
    for M in (Job, RecurringSchedule, Quote, LeadIntake, PropertyIcal, ICalEvent,
              PropertyCrewNote, PropertyPhoto):
        db.query(M).filter(M.property_id.in_(pids)).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(pids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(created["clients"])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_merge_reparents_everything_and_backfills(ctx):
    db, c, keeper, dup, _ = ctx
    # The duplicate carries the real detail; the keeper is missing it.
    dup.access_notes = "Lockbox by the side door, 4251"
    dup.wifi_ssid = "DockGuest"; dup.wifi_password = "cleanme"
    db.add_all([
        Job(client_id=c.id, property_id=dup.id, job_type="residential", title="J", status="scheduled", org_id=1),
        RecurringSchedule(client_id=c.id, property_id=dup.id, org_id=1, job_type="residential",
                          title="R", address="12 Dock Rd", frequency="weekly", day_of_week=2,
                          start_time=time(9, 0), end_time=time(11, 0)),
        Quote(client_id=c.id, property_id=dup.id, org_id=1, quote_number="Q-MP1", title="T",
              service_type="residential", items=[], subtotal=1, tax_rate=0, tax=0, discount=0,
              total=1, status="draft"),
        LeadIntake(name="L", property_id=dup.id, org_id=1),
        PropertyCrewNote(property_id=dup.id, body="Upstairs drain clogs"),
        PropertyPhoto(property_id=dup.id, content_type="image/jpeg", size_bytes=3, data=b"jpg"),
    ])
    db.commit()
    keeper_id, dup_id = keeper.id, dup.id  # capture before the merge deletes dup

    out = merge_properties(MergePropertiesBody(primary_id=keeper_id, duplicate_id=dup_id),
                           db=db, org_id=1)
    assert out["removed"] == dup_id
    assert out["moved"].get("jobs") == 1 and out["moved"].get("recurring_schedules") == 1

    db.expire_all()
    assert db.query(Property).filter(Property.id == dup_id).first() is None  # duplicate gone
    for M in (Job, RecurringSchedule, Quote, LeadIntake, PropertyCrewNote, PropertyPhoto):
        assert db.query(M).filter(M.property_id == dup_id).count() == 0     # nothing left behind
        assert db.query(M).filter(M.property_id == keeper_id).count() >= 1  # all on keeper
    keeper = db.query(Property).filter(Property.id == keeper_id).one()
    assert keeper.access_notes == "Lockbox by the side door, 4251"  # detail back-filled
    assert keeper.wifi_ssid == "DockGuest"


def test_merge_refuses_across_clients(ctx):
    db, c, keeper, dup, created = ctx
    other = Client(name="Other", email="other@example.com", status="active", org_id=1)
    db.add(other); db.commit(); db.refresh(other)
    created["clients"].append(other.id)
    dup.client_id = other.id
    db.commit()

    with pytest.raises(Exception) as ei:
        merge_properties(MergePropertiesBody(primary_id=keeper.id, duplicate_id=dup.id),
                         db=db, org_id=1)
    assert getattr(ei.value, "status_code", None) == 400
    db.expire_all()
    assert db.query(Property).filter(Property.id == dup.id).first() is not None  # untouched


def test_merge_refuses_on_overlapping_live_turnover(ctx):
    db, c, keeper, dup, _ = ctx
    keeper.property_type = "str"; dup.property_type = "str"
    db.commit()
    d = date(2026, 10, 15)
    # Both properties have a LIVE turnover on the same checkout date — the
    # (property_id, scheduled_date, job_type) live-turnover unique index would
    # collide on repoint.
    db.add_all([
        Job(client_id=c.id, property_id=keeper.id, job_type="str_turnover", title="K",
            status="scheduled", scheduled_date=d, org_id=1),
        Job(client_id=c.id, property_id=dup.id, job_type="str_turnover", title="D",
            status="scheduled", scheduled_date=d, org_id=1),
    ])
    db.commit()

    with pytest.raises(Exception) as ei:
        merge_properties(MergePropertiesBody(primary_id=keeper.id, duplicate_id=dup.id),
                         db=db, org_id=1)
    assert getattr(ei.value, "status_code", None) == 409
    db.rollback()
    db.expire_all()
    # Refused cleanly: the duplicate and both jobs still exist.
    assert db.query(Property).filter(Property.id == dup.id).first() is not None
    assert db.query(Job).filter(Job.property_id == dup.id).count() == 1


def test_merge_coalesces_duplicate_ical_events(ctx):
    db, c, keeper, dup, _ = ctx
    # Same feed uid on both properties — the keeper's stays, the duplicate's
    # redundant copy is coalesced away so the repoint doesn't violate
    # (property_id, uid).
    db.add_all([
        ICalEvent(property_id=keeper.id, uid="evt-1", checkout_date=date(2026, 10, 1)),
        ICalEvent(property_id=dup.id, uid="evt-1", checkout_date=date(2026, 10, 1)),
        ICalEvent(property_id=dup.id, uid="evt-2", checkout_date=date(2026, 10, 8)),
    ])
    db.commit()
    keeper_id, dup_id = keeper.id, dup.id

    out = merge_properties(MergePropertiesBody(primary_id=keeper_id, duplicate_id=dup_id),
                           db=db, org_id=1)
    assert out["removed"] == dup_id
    db.expire_all()
    uids = {u for (u,) in db.query(ICalEvent.uid).filter(ICalEvent.property_id == keeper_id).all()}
    assert uids == {"evt-1", "evt-2"}          # kept keeper's evt-1, moved evt-2
    assert db.query(ICalEvent).filter(ICalEvent.property_id == dup_id).count() == 0
