"""BB-CREW-01: a job every assigned cleaner has declined must read as uncovered.

A crew decline (/api/crew/jobs/{id}/respond) writes a JobResponse and leaves
Job.cleaner_ids alone on purpose — the office keeps schedule authority. So
find_uncovered, which keyed off empty cleaner_ids, treated an all-declined job
as covered: the office got one push when the decline landed and then nothing
re-surfaced the job. Now find_uncovered counts an all-declined job as uncovered
so the standing rule re-offers it (it only OPENS the job to the bench — never
assigns).
"""
import uuid
from datetime import date, time, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, JobResponse
import services.crew_escalation as ce


@pytest.fixture
def ctx():
    db = SessionLocal()
    made = {"jobs": [], "props": [], "clients": []}

    def seed(assigned):
        tag = uuid.uuid4().hex[:6]
        c = Client(name=f"Cov {tag}", status="active", email=f"cov-{tag}@example.com", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name=f"House {tag}", address="1 Cov Rd",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        j = Job(client_id=c.id, property_id=p.id, title=f"Clean {tag}", job_type="residential",
                scheduled_date=date.today() + timedelta(days=1), start_time=time(10, 0),
                end_time=time(13, 0), status="scheduled", cleaner_ids=assigned,
                open_for_claims=False, org_id=1)
        db.add(j); db.commit(); db.refresh(j)
        made["jobs"].append(j); made["props"].append(p); made["clients"].append(c)
        return j

    def respond(job, cleaner_id, response):
        db.add(JobResponse(org_id=1, job_id=job.id, cleaner_id=cleaner_id,
                           response=response))
        db.commit()

    yield db, seed, respond
    db.rollback()
    for j in made["jobs"]:
        db.query(JobResponse).filter(JobResponse.job_id == j.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    for p in made["props"]:
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    for c in made["clients"]:
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _uncovered_ids(db):
    return {j.id for j in ce.find_uncovered(db, hours=48, org_id=1)}


def test_an_assigned_job_nobody_declined_is_covered(ctx):
    db, seed, respond = ctx
    j = seed(assigned=["c1"])            # assigned, no response yet
    assert j.id not in _uncovered_ids(db)


def test_a_job_the_only_cleaner_declined_is_uncovered(ctx):
    db, seed, respond = ctx
    j = seed(assigned=["c1"])
    respond(j, "c1", "declined")
    assert j.id in _uncovered_ids(db), "an all-declined job never re-surfaced as uncovered"


def test_a_job_with_one_decline_and_one_still_on_it_is_covered(ctx):
    db, seed, respond = ctx
    j = seed(assigned=["c1", "c2"])
    respond(j, "c1", "declined")
    respond(j, "c2", "accepted")
    assert j.id not in _uncovered_ids(db)


def test_a_job_all_cleaners_declined_is_uncovered(ctx):
    db, seed, respond = ctx
    j = seed(assigned=["c1", "c2"])
    respond(j, "c1", "declined")
    respond(j, "c2", "declined")
    assert j.id in _uncovered_ids(db)


def test_an_unassigned_job_is_still_uncovered(ctx):
    # Existing behavior preserved.
    db, seed, respond = ctx
    j = seed(assigned=[])
    assert j.id in _uncovered_ids(db)
