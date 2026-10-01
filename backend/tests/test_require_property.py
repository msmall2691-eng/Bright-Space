"""Guardrail: every job and every recurring series hangs off a property.

Workflow audit (Oct 2026): a job/series born with no property floats free of an
address — the root of most duplicate/stale-visit drift. create_job already
resolved a property; create_schedule did not. Both now share one resolver
(services/property_resolve): supplied property → client's existing → auto-create
from address, else 422 when there's no property and no address to build one from.
"""
import uuid
from datetime import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, RecurringSchedule
from utils.dates import business_today

api = TestClient(app)


@pytest.fixture(autouse=True)
def _no_gcal():
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


def _client(**over):
    db = SessionLocal()
    fields = dict(name=f"Prop Guard {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    fields.update(over)
    c = Client(**fields)
    db.add(c); db.commit(); cid = c.id; db.close()
    return cid


def _property(client_id, **over):
    db = SessionLocal()
    fields = dict(client_id=client_id, name="Existing Home", address="1 Known Rd",
                  property_type="residential", org_id=1)
    fields.update(over)
    p = Property(**fields)
    db.add(p); db.commit(); pid = p.id; db.close()
    return pid


def _cleanup(cid):
    db = SessionLocal()
    db.query(Job).filter(Job.client_id == cid).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == cid).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == cid).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
    db.commit(); db.close()


def _job_payload(cid, **over):
    p = dict(client_id=cid, title="Clean", job_type="residential",
             scheduled_date=business_today().isoformat(), start_time="10:00", end_time="12:00")
    p.update(over)
    return p


def _series_payload(cid, **over):
    p = dict(client_id=cid, job_type="residential", title="Weekly", address="",
             frequency="weekly", interval_weeks=1, days_of_week=[business_today().weekday()],
             start_time="10:00", end_time="12:00", property_id=None, generate_weeks_ahead=1)
    p.update(over)
    return p


# ── Jobs ────────────────────────────────────────────────────────────────────

def test_job_uses_clients_sole_property():
    cid = _client()
    pid = _property(cid)
    try:
        r = api.post("/api/jobs", json=_job_payload(cid))   # no property_id sent
        assert r.status_code in (200, 201), r.text
        assert r.json()["property_id"] == pid
    finally:
        _cleanup(cid)


def test_job_autocreates_property_from_client_address():
    cid = _client(address="42 New Service Ln")
    try:
        r = api.post("/api/jobs", json=_job_payload(cid))   # no property, but client has address
        assert r.status_code in (200, 201), r.text
        new_pid = r.json()["property_id"]
        assert new_pid
        db = SessionLocal()
        prop = db.query(Property).filter(Property.id == new_pid).first()
        assert prop.client_id == cid and prop.address == "42 New Service Ln"
        db.close()
    finally:
        _cleanup(cid)


def test_job_422_when_no_property_and_no_address():
    cid = _client()   # no property, no address
    try:
        r = api.post("/api/jobs", json=_job_payload(cid))
        assert r.status_code == 422, r.text
        assert "address" in r.text.lower()
        db = SessionLocal()
        assert db.query(Job).filter(Job.client_id == cid).count() == 0
        db.close()
    finally:
        _cleanup(cid)


def test_job_rejects_property_of_a_different_client():
    cid = _client(address="9 Mine St")
    other = _client(address="9 Theirs St")
    other_pid = _property(other)
    try:
        r = api.post("/api/jobs", json=_job_payload(cid, property_id=other_pid))
        assert r.status_code == 400, r.text
    finally:
        _cleanup(cid); _cleanup(other)


# ── Recurring series ─────────────────────────────────────────────────────────

def test_series_uses_clients_sole_property():
    cid = _client()
    pid = _property(cid)
    try:
        r = api.post("/api/recurring", json=_series_payload(cid))
        assert r.status_code == 201, r.text
        db = SessionLocal()
        sched = db.query(RecurringSchedule).filter(RecurringSchedule.client_id == cid).first()
        assert sched.property_id == pid
        db.close()
    finally:
        _cleanup(cid)


def test_series_autocreates_property_from_address():
    cid = _client()
    try:
        r = api.post("/api/recurring", json=_series_payload(cid, address="7 Repeat Rd"))
        assert r.status_code == 201, r.text
        db = SessionLocal()
        sched = db.query(RecurringSchedule).filter(RecurringSchedule.client_id == cid).first()
        assert sched.property_id is not None
        prop = db.query(Property).filter(Property.id == sched.property_id).first()
        assert prop.address == "7 Repeat Rd"
        db.close()
    finally:
        _cleanup(cid)


def test_series_422_when_no_property_and_no_address():
    cid = _client()   # no property, blank address in payload, none on client
    try:
        r = api.post("/api/recurring", json=_series_payload(cid, address=""))
        assert r.status_code == 422, r.text
        db = SessionLocal()
        assert db.query(RecurringSchedule).filter(RecurringSchedule.client_id == cid).count() == 0
        db.close()
    finally:
        _cleanup(cid)
