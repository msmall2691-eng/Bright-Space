"""GET /api/clients/{id}/profile — the Clients list's ClientPeek quick-view
lives entirely on this one endpoint. Regression coverage for a bug that 500d
it for any client with a scheduled job: Job.scheduled_date is a Date column
(a real `date`), but the endpoint compared it against
`business_today().isoformat()` (a str) — `date >= str` raises TypeError.

ClientProfile.jsx's data hook silently degrades around this exact failure
(catches the /profile fetch, falls back to plain /clients/{id}, per
useClientProfileData.js), which is why the bug went unnoticed on the full
page. ClientPeek.jsx has no such fallback — it renders the raw ErrorState
default text ("We couldn't load this. Check your connection and try
again."), which is what the owner screenshotted.
"""
from datetime import date, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job


@pytest.fixture
def client_with_jobs():
    db = SessionLocal()
    c = Client(name="Profile Endpoint Test", phone="2075550111", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="1 Test Ave", address="1 Test Ave")
    db.add(p); db.commit(); db.refresh(p)

    today = date.today()
    upcoming = Job(client_id=c.id, property_id=p.id, title="Upcoming Clean",
                    job_type="residential", status="scheduled",
                    scheduled_date=today + timedelta(days=7))
    past = Job(client_id=c.id, property_id=p.id, title="Past Clean",
               job_type="residential", status="completed",
               scheduled_date=today - timedelta(days=7))
    db.add_all([upcoming, past]); db.commit()

    yield db, c

    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_profile_endpoint_splits_scheduled_jobs_without_raising(client_with_jobs):
    """This is the exact call ClientPeek.jsx makes on every row click — it
    must not raise for a client with a real, dated job."""
    from modules.clients.router import get_client_profile

    db, c = client_with_jobs
    profile = get_client_profile(c.id, db=db, org_id=None)

    assert len(profile["upcoming_visits"]) == 1
    assert profile["upcoming_visits"][0]["title"] == "Upcoming Clean"
    assert len(profile["past_visits"]) == 1
    assert profile["past_visits"][0]["title"] == "Past Clean"
    assert profile["visit_stats"]["total"] == 2
    assert profile["visit_stats"]["upcoming"] == 1
    assert profile["visit_stats"]["completed"] == 1
