"""One-way self-heal: reassert_deleted_gcal_events re-pushes events a user
deleted in Google (BrightBase is master), and — critically — NEVER clears an id
on a false "missing", which would make the push create a duplicate.

Covers: the happy path (a deleted event's id is cleared for re-push while a live
one is left alone), the mass-wipe guard (an implausible number of missing →
clear nothing), a list failure (clear nothing), and two-way mode (skip).
"""
from datetime import timedelta
from unittest.mock import patch, MagicMock

from database.db import SessionLocal
from database.models import Client, Job, Property
from utils.dates import business_today


def _service_listing(event_ids, raise_on_list=False):
    """Fake Google service whose events().list().execute() returns events with
    the given ids (all 'confirmed'). Set raise_on_list to simulate an API error."""
    svc = MagicMock()
    if raise_on_list:
        svc.events.return_value.list.return_value.execute.side_effect = RuntimeError("boom")
    else:
        svc.events.return_value.list.return_value.execute.return_value = {
            "items": [{"id": eid, "status": "confirmed"} for eid in event_ids]
        }
    return svc


def _seed(db, n, tag):
    client = Client(name=f"Reassert {tag}", email=f"reassert-{tag}@example.com")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="P", address="1 Test St",
                    property_type="residential", active=True)
    db.add(prop); db.commit(); db.refresh(prop)
    d = business_today() + timedelta(days=5)
    jobs = []
    for i in range(n):
        j = Job(client_id=client.id, property_id=prop.id, job_type="residential",
                title=f"Clean {i}", scheduled_date=d, gcal_event_id=f"{tag}_evt_{i}",
                status="scheduled")
        db.add(j); jobs.append(j)
    db.commit()
    for j in jobs:
        db.refresh(j)
    return jobs


def _run(db, present_ids, raise_on_list=False, source="brightbase"):
    from integrations import gcal_sync
    with patch("integrations.google_calendar._get_service",
               return_value=_service_listing(present_ids, raise_on_list)), \
         patch("integrations.gcal_sync.calendar_source_of_truth", return_value=source):
        return gcal_sync.reassert_deleted_gcal_events(db)


def test_clears_only_the_deleted_events_id_for_repush():
    db = SessionLocal()
    try:
        jobs = _seed(db, 2, "happy")
        # jobs[0]'s event is still in Google; jobs[1]'s was deleted (absent).
        res = _run(db, present_ids=[jobs[0].gcal_event_id])
        assert res["restored"] == 1
        db.refresh(jobs[0]); db.refresh(jobs[1])
        assert jobs[0].gcal_event_id is not None, "a live event must be left alone"
        assert jobs[1].gcal_event_id is None, "a deleted event's id is cleared for re-push"
    finally:
        db.close()


def test_mass_wipe_guard_clears_nothing_on_implausible_missing():
    db = SessionLocal()
    try:
        jobs = _seed(db, 8, "mass")
        # Google returns NOTHING for all 8 linked jobs — an API anomaly, not a
        # real bulk delete. Clearing them would spawn 8 duplicate events.
        res = _run(db, present_ids=[])
        assert res["restored"] == 0 and res.get("skipped") == "guard"
        for j in jobs:
            db.refresh(j)
            assert j.gcal_event_id is not None, "guard must leave every id intact"
    finally:
        db.close()


def test_list_failure_clears_nothing():
    db = SessionLocal()
    try:
        jobs = _seed(db, 2, "listfail")
        res = _run(db, present_ids=[], raise_on_list=True)
        assert res["restored"] == 0 and "error" in res
        for j in jobs:
            db.refresh(j)
            assert j.gcal_event_id is not None
    finally:
        db.close()


def test_two_way_mode_is_skipped():
    db = SessionLocal()
    try:
        jobs = _seed(db, 1, "twoway")
        res = _run(db, present_ids=[], source="google")
        assert res.get("skipped") == "two_way"
        db.refresh(jobs[0])
        assert jobs[0].gcal_event_id is not None
    finally:
        db.close()
