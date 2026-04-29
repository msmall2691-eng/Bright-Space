"""Tests for visit pre-materialization: when a recurring schedule generates jobs,
each Job should also get a Visit so the calendar UI can show individual occurrences."""
import pytest
from datetime import date, time, timedelta
from database.models import RecurringSchedule, Job, Visit, Client, Property
from database.db import SessionLocal
from modules.recurring.router import generate_jobs


@pytest.fixture
def test_client_and_property():
    """Create a throwaway client + property for recurring schedule tests."""
    db = SessionLocal()
    client = Client(name="Recurring Test Client", phone="+12075550100", phone_tail="2075550100", status="active")
    db.add(client)
    db.commit()
    db.refresh(client)

    prop = Property(
        client_id=client.id,
        name="Test Home",
        address="123 Test St",
        property_type="residential",
    )
    db.add(prop)
    db.commit()
    db.refresh(prop)

    yield client, prop

    # Cleanup: cascade through schedules → jobs → visits
    db.query(Visit).join(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == client.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_generate_jobs_creates_visit_per_job(test_client_and_property):
    """When generate_jobs runs, every new Job should also get a corresponding Visit."""
    client, prop = test_client_and_property
    db = SessionLocal()
    try:
        sched = RecurringSchedule(
            client_id=client.id,
            property_id=prop.id,
            job_type="residential",
            title="Weekly Test Clean",
            address=prop.address,
            frequency="weekly",
            interval_weeks=1,
            day_of_week=date.today().weekday(),  # today's weekday so we definitely get jobs
            days_of_week=[date.today().weekday()],
            start_time=time(9, 0),
            end_time=time(11, 0),
            cleaner_ids=[],
            generate_weeks_ahead=4,
            active=True,
        )
        db.add(sched)
        db.commit()
        db.refresh(sched)

        created = generate_jobs(db, sched)
        assert created > 0, "expected at least one job to be generated"

        jobs = db.query(Job).filter(Job.recurring_schedule_id == sched.id).all()
        assert len(jobs) == created

        # Each job should have exactly one visit pre-materialized
        for job in jobs:
            visits = db.query(Visit).filter(Visit.job_id == job.id).all()
            assert len(visits) == 1, f"Job {job.id} should have exactly one Visit, found {len(visits)}"
            v = visits[0]
            assert v.scheduled_date == job.scheduled_date
            assert v.start_time == job.start_time
            assert v.end_time == job.end_time
            assert v.status == "scheduled"
    finally:
        db.close()


def test_skip_visit_marks_visit_and_job_cancelled(test_client_and_property):
    """POST /api/visits/{id}/skip should cancel both visit + parent job, but leave schedule active."""
    from fastapi.testclient import TestClient
    from main import app
    client_app = TestClient(app)

    client, prop = test_client_and_property
    db = SessionLocal()
    try:
        sched = RecurringSchedule(
            client_id=client.id,
            property_id=prop.id,
            job_type="residential",
            title="Weekly Test Clean",
            address=prop.address,
            frequency="weekly",
            interval_weeks=1,
            day_of_week=date.today().weekday(),
            days_of_week=[date.today().weekday()],
            start_time=time(9, 0),
            end_time=time(11, 0),
            cleaner_ids=[],
            generate_weeks_ahead=2,
            active=True,
        )
        db.add(sched)
        db.commit()
        db.refresh(sched)
        generate_jobs(db, sched)

        # Pick the first generated visit
        first_visit = (
            db.query(Visit)
            .join(Job)
            .filter(Job.recurring_schedule_id == sched.id)
            .order_by(Visit.scheduled_date)
            .first()
        )
        assert first_visit is not None
        visit_id = first_visit.id
        job_id = first_visit.job_id

        # Skip it
        response = client_app.post(f"/api/visits/{visit_id}/skip", params={"reason": "client out of town"})
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "cancelled"
        assert data["job_status"] == "cancelled"

        # Re-query to verify DB state
        db.expire_all()
        v = db.query(Visit).filter(Visit.id == visit_id).first()
        j = db.query(Job).filter(Job.id == job_id).first()
        s = db.query(RecurringSchedule).filter(RecurringSchedule.id == sched.id).first()

        assert v.status == "cancelled"
        assert j.status == "cancelled"
        assert s.active is True, "Recurring schedule should still be active after skipping a single visit"
    finally:
        db.close()
