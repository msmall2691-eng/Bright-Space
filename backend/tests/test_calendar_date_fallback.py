"""Regression test: GET /api/jobs falls back to visits.scheduled_date.

Some code paths historically created Job rows without populating
Job.scheduled_date — the date lived only on the Visit row. The calendar
fetches /api/jobs?date_from=&date_to= and used to miss those rows entirely.
The fix outer-joins the earliest visit date and matches against it when
Job.scheduled_date is NULL.
"""
import pytest
from datetime import date, time, timedelta

from sqlalchemy import func
from database.db import SessionLocal, engine
from database.models import Base, Client, Property, Job, Visit


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_test_schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def fresh_client():
    db = SessionLocal()
    client = Client(
        name="Calendar Fallback Test",
        phone="+12075559900",
        phone_tail="2075559900",
        status="active",
    )
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(
        client_id=client.id,
        name="Fallback Property",
        address="9 Fallback Way",
        property_type="residential",
    )
    db.add(prop); db.commit(); db.refresh(prop)
    yield client, prop
    db.query(Visit).filter(Visit.job_id.in_(
        db.query(Job.id).filter(Job.client_id == client.id)
    )).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_jobs_endpoint_returns_null_scheduled_date_jobs_via_visit(fresh_client):
    """A Job with scheduled_date=NULL and a Visit in range should surface."""
    from fastapi.testclient import TestClient
    from main import app
    from modules.auth.router import get_current_user
    from database.models import User as UserModel

    class _AdminStub:
        id = 0
        role = "admin"
        email = "test@brightspace.local"
        active = True

    app.dependency_overrides[get_current_user] = lambda: _AdminStub()
    api = TestClient(app)

    client, prop = fresh_client
    db = SessionLocal()
    try:
        target = date.today() + timedelta(days=3)
        job = Job(
            client_id=client.id,
            property_id=prop.id,
            job_type="residential",
            title="Calendar Fallback Job",
            address="9 Fallback Way",
            scheduled_date=None,
            start_time=time(9, 0),
            end_time=time(11, 0),
            cleaner_ids=[],
            status="scheduled",
        )
        db.add(job); db.commit(); db.refresh(job)

        # SQLite + BigInteger doesn't auto-increment; pick next free id manually.
        next_visit_id = (db.query(func.max(Visit.id)).scalar() or 0) + 1
        visit = Visit(
            id=next_visit_id,
            job_id=job.id,
            scheduled_date=target,
            start_time=time(9, 0),
            end_time=time(11, 0),
            cleaner_ids=[],
            status="scheduled",
        )
        db.add(visit); db.commit()

        date_from = (target - timedelta(days=1)).isoformat()
        date_to = (target + timedelta(days=1)).isoformat()
        r = api.get(f"/api/jobs?date_from={date_from}&date_to={date_to}")
        assert r.status_code == 200, r.text
        ids = [row["id"] for row in r.json()]
        assert job.id in ids, (
            f"Job {job.id} (scheduled_date=NULL, visit on {target}) was not "
            f"returned by /api/jobs?date_from={date_from}&date_to={date_to}. "
            f"Got: {ids}"
        )
    finally:
        db.close()


def test_jobs_endpoint_excludes_null_jobs_outside_visit_range(fresh_client):
    """A Job with NULL scheduled_date whose Visit is OUTSIDE the range
    should NOT come back."""
    from fastapi.testclient import TestClient
    from main import app
    from modules.auth.router import get_current_user
    from database.models import User as UserModel

    class _AdminStub:
        id = 0
        role = "admin"
        email = "test@brightspace.local"
        active = True

    app.dependency_overrides[get_current_user] = lambda: _AdminStub()
    api = TestClient(app)

    client, prop = fresh_client
    db = SessionLocal()
    try:
        far_target = date.today() + timedelta(days=200)
        job = Job(
            client_id=client.id,
            property_id=prop.id,
            job_type="residential",
            title="Far Future Job",
            address="9 Fallback Way",
            scheduled_date=None,
            start_time=time(9, 0),
            end_time=time(11, 0),
            cleaner_ids=[],
            status="scheduled",
        )
        db.add(job); db.commit(); db.refresh(job)

        next_visit_id = (db.query(func.max(Visit.id)).scalar() or 0) + 1
        visit = Visit(
            id=next_visit_id,
            job_id=job.id,
            scheduled_date=far_target,
            start_time=time(9, 0),
            end_time=time(11, 0),
            cleaner_ids=[],
            status="scheduled",
        )
        db.add(visit); db.commit()

        today = date.today()
        r = api.get(
            f"/api/jobs?date_from={today.isoformat()}"
            f"&date_to={(today + timedelta(days=30)).isoformat()}"
        )
        assert r.status_code == 200
        ids = [row["id"] for row in r.json()]
        assert job.id not in ids
    finally:
        db.close()
