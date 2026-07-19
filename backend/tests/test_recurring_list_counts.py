"""GET /api/recurring annotates each series with upcoming_job_count. The count
is computed in ONE grouped query (not a COUNT per row); this pins that it stays
per-series-correct: only future, non-cancelled jobs, attributed to the right
schedule.
"""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, RecurringSchedule, Job
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 7621, 1, "admin", "active", True
    email = "rec-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _sched(db, client_id, property_id, title):
    s = RecurringSchedule(
        client_id=client_id, property_id=property_id, job_type="residential", title=title,
        address="1 A St", frequency="biweekly", interval_weeks=2,
        days_of_week=[0], day_of_week=0, start_time=time(9, 0), end_time=time(11, 0),
        active=True, org_id=1,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def _job(db, client_id, property_id, sched_id, d, status="scheduled"):
    j = Job(client_id=client_id, property_id=property_id, recurring_schedule_id=sched_id,
            job_type="residential", title="Clean", scheduled_date=d, start_time=time(9, 0),
            end_time=time(11, 0), status=status, org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    return j


def test_upcoming_job_count_is_per_series_and_excludes_past_and_cancelled(api):
    db = SessionLocal()
    made = []
    try:
        c = Client(name=f"Counts {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="Home", address="1 A St",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        today = business_today()

        s1 = _sched(db, c.id, p.id, "Series One")
        s2 = _sched(db, c.id, p.id, "Series Two")
        made = [s1, s2, p, c]

        # s1: 2 future + 1 past + 1 cancelled-future  → count should be 2
        made.append(_job(db, c.id, p.id, s1.id, today + timedelta(days=1)))
        made.append(_job(db, c.id, p.id, s1.id, today + timedelta(days=15)))
        made.append(_job(db, c.id, p.id, s1.id, today - timedelta(days=7)))          # past
        made.append(_job(db, c.id, p.id, s1.id, today + timedelta(days=8),
                         status="cancelled"))                                        # cancelled
        # s2: 1 future → count should be 1
        made.append(_job(db, c.id, p.id, s2.id, today + timedelta(days=2)))

        r = api.get("/api/recurring")
        assert r.status_code == 200, r.text
        by_id = {row["id"]: row for row in r.json()}
        assert by_id[s1.id]["upcoming_job_count"] == 2
        assert by_id[s2.id]["upcoming_job_count"] == 1
    finally:
        for m in made:
            db.delete(m)
        db.commit(); db.close()
