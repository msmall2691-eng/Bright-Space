"""Jobs are fully editable after creation (June 12): title, type, property,
address, status — and property_id actually persists (the edit modal always
sent it, but JobUpdate never declared it, so pydantic silently dropped it).
"""
import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import update_job, JobUpdate


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Job Edit Test", email="jobedit@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p1 = Property(client_id=c.id, name="P1", address="1 First St", property_type="residential", active=True)
    p2 = Property(client_id=c.id, name="P2", address="2 Second Ave", property_type="commercial", active=True)
    db.add_all([p1, p2]); db.commit(); db.refresh(p1); db.refresh(p2)
    j = Job(client_id=c.id, property_id=p1.id, title="Original title",
            job_type="residential", status="scheduled", address="1 First St")
    db.add(j); db.commit(); db.refresh(j)
    yield db, c, p1, p2, j
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_every_job_field_is_editable(ctx):
    db, c, p1, p2, j = ctx
    update_job(j.id, JobUpdate(
        title="Renamed — deep clean",
        job_type="commercial",
        property_id=p2.id,
        address="2 Second Ave",
        status="in_progress",
        notes="bring ladder",
    ), db=db)
    db.refresh(j)
    assert j.title == "Renamed — deep clean"          # title was display-only in the UI
    assert j.job_type == "commercial"
    assert j.property_id == p2.id                     # was silently dropped before
    assert j.address == "2 Second Ave"
    assert j.status == "in_progress"
    assert j.notes == "bring ladder"


def test_invalid_job_type_and_status_are_rejected(ctx):
    db, c, p1, p2, j = ctx
    with pytest.raises(HTTPException) as ei:
        update_job(j.id, JobUpdate(job_type="lawn_mowing"), db=db)
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        update_job(j.id, JobUpdate(status="snoozed"), db=db)
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        update_job(j.id, JobUpdate(property_id=99999999), db=db)
    assert ei.value.status_code == 404
    db.refresh(j)
    assert j.job_type == "residential" and j.status == "scheduled"  # untouched


def test_cross_client_property_is_rejected(ctx):
    """Codex P1 (#271): re-pointing a job at another client's property would
    leave invoices/activities/calendar tied to the old client."""
    db, c, p1, p2, j = ctx
    other = Client(name="Other Client", email="other@example.com", status="active")
    db.add(other); db.commit(); db.refresh(other)
    theirs = Property(client_id=other.id, name="Theirs", address="9 Elsewhere",
                      property_type="residential", active=True)
    db.add(theirs); db.commit(); db.refresh(theirs)
    try:
        with pytest.raises(HTTPException) as ei:
            update_job(j.id, JobUpdate(property_id=theirs.id), db=db)
        assert ei.value.status_code == 400
        assert "different client" in ei.value.detail
        db.refresh(j)
        assert j.property_id == p1.id  # untouched
    finally:
        db.query(Property).filter(Property.id == theirs.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == other.id).delete(synchronize_session=False)
        db.commit()


def test_status_change_propagates_to_active_visits(ctx):
    """Codex P1 (#271): the schedule reads Visit.status — a job completed via
    the edit modal must not leave its visits looking scheduled/actionable."""
    from database.models import Visit
    db, c, p1, p2, j = ctx
    from datetime import date, time
    v_active = Visit(job_id=j.id, scheduled_date=date(2026, 6, 20),
                     start_time=time(9, 0), end_time=time(12, 0), status="scheduled")
    v_done = Visit(job_id=j.id, scheduled_date=date(2026, 6, 13),
                   start_time=time(9, 0), end_time=time(12, 0), status="cancelled")
    db.add_all([v_active, v_done]); db.commit()
    try:
        update_job(j.id, JobUpdate(status="completed"), db=db)
        db.refresh(v_active); db.refresh(v_done)
        assert v_active.status == "completed"   # followed the job
        assert v_done.status == "cancelled"     # terminal states untouched
    finally:
        db.query(Visit).filter(Visit.job_id == j.id).delete(synchronize_session=False)
        from database.models import Invoice
        db.query(Invoice).filter(Invoice.job_id == j.id).delete(synchronize_session=False)
        db.commit()


def test_job_type_change_moves_the_calendar_event(ctx, monkeypatch):
    """Codex P2 (#271): per-type calendars — updating in place after a type
    change looks for the event on the WRONG calendar. The event must move."""
    from unittest.mock import patch as mpatch
    db, c, p1, p2, j = ctx
    j.gcal_event_id = "evt-old"
    db.commit()
    monkeypatch.setenv("GCAL_RESIDENTIAL_ID", "cal-res")
    monkeypatch.setenv("GCAL_COMMERCIAL_ID", "cal-com")
    with mpatch("integrations.google_calendar.delete_event", return_value=True) as dele, \
         mpatch("integrations.google_calendar.create_event", return_value="evt-new") as crea, \
         mpatch("integrations.google_calendar.update_event") as upd:
        update_job(j.id, JobUpdate(job_type="commercial"), db=db)
    db.refresh(j)
    # Deleted from the OLD type's calendar, recreated on the new one.
    assert dele.call_args.args[1] == "residential"
    assert crea.called
    assert not upd.called
    assert j.gcal_event_id == "evt-new"
