"""Client + property archive lifecycle.

Archiving a client (or property) takes it out of active workflows in one action
— stop recurring, cancel FUTURE visits, dismiss future turnover bookings, close
offers, archive open quotes — while preserving all history and invoices, and is
reversible. Scheduling-invariants R7: archive never hard-deletes a Job; only the
force/permanent delete removes rows, and only when it can't destroy job history.
"""
import uuid
import datetime as dt
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (Client, Property, Job, RecurringSchedule, ICalEvent,
                             Quote, Invoice)
from modules.auth.router import get_current_user, current_org_id
from services import client_lifecycle as CL


class _Admin:
    id, org_id, role, status, active = 8201, 1, "admin", "active", True
    email = "lifecycle-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    yield TestClient(app)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _seed(db, *, with_future_job=True, with_past_job=True, with_recurring=True,
          with_booking=True, with_quote=True, with_invoice=True):
    ids = {}
    c = Client(name=f"Spin Drift {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    prop = Property(client_id=c.id, name="Wells rental", address="9 Shore Rd",
                    property_type="str", active=True, org_id=1)
    db.add(prop); db.commit(); db.refresh(prop)
    today = dt.date.today()
    if with_future_job:
        fj = Job(client_id=c.id, property_id=prop.id, job_type="str_turnover",
                 title="Future", status="scheduled", scheduled_date=today + timedelta(days=7), org_id=1)
        db.add(fj)
    if with_past_job:
        pj = Job(client_id=c.id, property_id=prop.id, job_type="residential",
                 title="Past done", status="completed", scheduled_date=today - timedelta(days=7), org_id=1)
        db.add(pj)
    if with_recurring:
        rs = RecurringSchedule(client_id=c.id, property_id=prop.id, active=True, org_id=1,
                               job_type="residential", title="Biweekly clean", address="9 Shore Rd",
                               frequency="biweekly", interval_weeks=2, day_of_week=2,
                               start_time=dt.time(9, 0), end_time=dt.time(12, 0))
        db.add(rs)
    if with_booking:
        ev = ICalEvent(property_id=prop.id, uid=f"b-{uuid.uuid4().hex[:6]}@feed",
                       event_type="reservation",
                       checkout_date=(today + timedelta(days=7)).isoformat(), org_id=1)
        db.add(ev)
    if with_quote:
        q = Quote(client_id=c.id, quote_number=f"Q-{uuid.uuid4().hex[:6]}",
                  status="sent", total=200, org_id=1)
        db.add(q)
    if with_invoice:
        inv = Invoice(client_id=c.id, invoice_number=f"I-{uuid.uuid4().hex[:6]}",
                      status="sent", total=200, org_id=1)
        db.add(inv)
    db.commit()
    ids.update(client=c.id, prop=prop.id)
    return ids


def _cleanup(db, ids):
    pid, cid = ids.get("prop"), ids.get("client")
    db.query(ICalEvent).filter(ICalEvent.property_id == pid).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == cid).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == cid).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == cid).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.client_id == cid).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == cid).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
    db.commit()


def test_archive_client_cascade_and_preserves_history():
    db = SessionLocal()
    ids = _seed(db)
    try:
        client = db.query(Client).get(ids["client"])
        out = CL.archive_client(db, client, actor_id=99)
        assert out["visits_cancelled"] == 1
        assert out["recurring_stopped"] == 1
        assert out["bookings_dismissed"] == 1
        assert out["quotes_archived"] == 1
        assert out["properties_archived"] == 1

        db.expire_all()
        # Client + property archived.
        assert db.query(Client).get(ids["client"]).archived_at is not None
        assert db.query(Property).get(ids["prop"]).active is False
        assert db.query(Property).get(ids["prop"]).archived_at is not None
        # Future visit cancelled; PAST/completed job preserved (R7).
        jobs = db.query(Job).filter(Job.client_id == ids["client"]).all()
        by_title = {j.title: j.status for j in jobs}
        assert by_title["Future"] == "cancelled"
        assert by_title["Past done"] == "completed"
        # Recurring stopped, booking dismissed, quote archived, invoice UNTOUCHED.
        assert db.query(RecurringSchedule).filter_by(client_id=ids["client"]).first().active is False
        assert db.query(ICalEvent).filter_by(property_id=ids["prop"]).first().dismissed_at is not None
        assert db.query(Quote).filter_by(client_id=ids["client"]).first().archived_at is not None
        assert db.query(Invoice).filter_by(client_id=ids["client"]).first().status == "sent"
    finally:
        _cleanup(db, ids); db.close()


def test_unarchive_restores_and_resumes_but_not_cancelled_work():
    db = SessionLocal()
    ids = _seed(db)
    try:
        client = db.query(Client).get(ids["client"])
        CL.archive_client(db, client, actor_id=99)
        db.expire_all()
        client = db.query(Client).get(ids["client"])
        out = CL.unarchive_client(db, client)
        assert out["properties_restored"] == 1
        assert out["bookings_resumed"] == 1

        db.expire_all()
        assert db.query(Client).get(ids["client"]).archived_at is None
        assert db.query(Property).get(ids["prop"]).active is True
        assert db.query(Property).get(ids["prop"]).archived_at is None
        # Feed resumes (dismissal cleared)…
        assert db.query(ICalEvent).filter_by(property_id=ids["prop"]).first().dismissed_at is None
        # …but the cancelled visit and stopped series are NOT resurrected (R7).
        fut = db.query(Job).filter_by(client_id=ids["client"], title="Future").first()
        assert fut.status == "cancelled"
        assert db.query(RecurringSchedule).filter_by(client_id=ids["client"]).first().active is False
    finally:
        _cleanup(db, ids); db.close()


def test_unarchive_does_not_clear_an_individually_deleted_turnover():
    """A booking dismissed by an office 'delete this turnover' (tag 'office
    delete') must stay dismissed through a client archive+unarchive cycle."""
    db = SessionLocal()
    ids = _seed(db)
    try:
        ev = db.query(ICalEvent).filter_by(property_id=ids["prop"]).first()
        ev.dismissed_at = dt.datetime.now(); ev.dismissed_by = "office delete"
        db.commit()
        client = db.query(Client).get(ids["client"])
        CL.archive_client(db, client, actor_id=99)
        db.expire_all()
        CL.unarchive_client(db, db.query(Client).get(ids["client"]))
        db.expire_all()
        ev = db.query(ICalEvent).filter_by(property_id=ids["prop"]).first()
        assert ev.dismissed_at is not None      # still gone — archive didn't own this one
        assert ev.dismissed_by == "office delete"
    finally:
        _cleanup(db, ids); db.close()


def test_endpoints_archive_preview_unarchive(api):
    db = SessionLocal()
    ids = _seed(db)
    try:
        pv = api.get(f"/api/clients/{ids['client']}/archive-preview").json()
        assert pv["upcoming_visits"] == 1 and pv["recurring_series"] == 1 and pv["open_quotes"] == 1

        r = api.post(f"/api/clients/{ids['client']}/archive")
        assert r.status_code == 200, r.text
        assert r.json()["visits_cancelled"] == 1
        db2 = SessionLocal()
        assert db2.query(Client).get(ids["client"]).archived_at is not None
        db2.close()

        r2 = api.post(f"/api/clients/{ids['client']}/unarchive")
        assert r2.status_code == 200, r2.text
        db3 = SessionLocal()
        assert db3.query(Client).get(ids["client"]).archived_at is None
        db3.close()
    finally:
        _cleanup(db, ids); db.close()


def test_permanent_property_delete_guarded_by_jobs(api):
    db = SessionLocal()
    ids = _seed(db)  # has jobs
    try:
        # With jobs → 409, property preserved.
        r = api.delete(f"/api/properties/{ids['prop']}?permanent=true")
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "property_has_jobs"
        assert db.query(Property).get(ids["prop"]) is not None
    finally:
        _cleanup(db, ids); db.close()


def test_permanent_property_delete_when_no_jobs(api):
    db = SessionLocal()
    ids = _seed(db, with_future_job=False, with_past_job=False, with_recurring=False,
                with_quote=False, with_invoice=False)
    try:
        pid = ids["prop"]
        r = api.delete(f"/api/properties/{pid}?permanent=true")
        assert r.status_code == 204, r.text
        db2 = SessionLocal()
        assert db2.query(Property).get(pid) is None
        assert db2.query(ICalEvent).filter_by(property_id=pid).count() == 0  # cascaded
        db2.close()
    finally:
        _cleanup(db, ids); db.close()


def test_default_property_delete_archives(api):
    db = SessionLocal()
    ids = _seed(db)
    try:
        r = api.delete(f"/api/properties/{ids['prop']}")
        assert r.status_code == 204, r.text
        db2 = SessionLocal()
        prop = db2.query(Property).get(ids["prop"])
        assert prop is not None and prop.active is False and prop.archived_at is not None
        assert db2.query(Job).filter_by(property_id=ids["prop"], title="Future").first().status == "cancelled"
        db2.close()
    finally:
        _cleanup(db, ids); db.close()
