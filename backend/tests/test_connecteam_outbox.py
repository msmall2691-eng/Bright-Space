"""Transactional outbox for Connecteam shift sync.

Hermetic: the Connecteam HTTP layer is monkeypatched, so these exercise the
enqueue/dedupe/drain/retry mechanics against a real SQLite session (the unique
constraint and status transitions need a real DB, unlike the FakeDB unit tests
in test_connecteam_auto.py).
"""
import uuid
from datetime import date, time

import pytest

from database.db import SessionLocal, engine
from database.base import Base
from database.models import Client, Property, Job, ConnecteamOutbox
import integrations.connecteam_auto as ca
import integrations.connecteam_outbox as ob


@pytest.fixture(scope="module", autouse=True)
def _schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def job(db):
    c = Client(name=f"OutboxCo {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Way",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Clean", job_type="residential",
            scheduled_date=date(2026, 9, 1), start_time=time(9, 0), end_time=time(11, 0),
            status="scheduled", cleaner_ids=["emp_a"], connecteam_shift_ids=[], org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    yield j
    db.query(ConnecteamOutbox).filter(ConnecteamOutbox.job_id == j.id).delete()
    db.query(Job).filter(Job.id == j.id).delete()
    db.query(Property).filter(Property.id == p.id).delete()
    db.query(Client).filter(Client.id == c.id).delete()
    db.commit()


@pytest.fixture
def ct_configured(monkeypatch):
    """Connecteam 'connected' with recording create/delete stubs."""
    monkeypatch.setattr(ob, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "_log", lambda *a, **k: None)
    created, deleted = [], []
    monkeypatch.setattr(ca, "create_shift_sync",
                        lambda **kw: (created.append(kw), {"id": f"sh{len(created)}"})[1])
    monkeypatch.setattr(ca, "create_open_shift_sync",
                        lambda **kw: (created.append(kw), {"id": f"open{len(created)}"})[1])
    monkeypatch.setattr(ca, "delete_shift_sync", lambda sid: deleted.append(sid))
    return created, deleted


def test_enqueue_is_idempotent_for_same_state(db, job):
    ob.enqueue_sync(db, job, "dispatch", commit=True)
    ob.enqueue_sync(db, job, "dispatch", commit=True)  # same desired state
    rows = db.query(ConnecteamOutbox).filter(ConnecteamOutbox.job_id == job.id).all()
    assert len(rows) == 1, "a repeat enqueue of the same state must collapse to one row"


def test_enqueue_new_state_after_reschedule_queues_again(db, job):
    ob.enqueue_sync(db, job, "dispatch", commit=True)
    job.start_time = time(14, 0)  # rescheduled → new desired state → new intent
    db.commit()
    ob.enqueue_sync(db, job, "dispatch", commit=True)
    rows = db.query(ConnecteamOutbox).filter(ConnecteamOutbox.job_id == job.id).all()
    assert len(rows) == 2


def test_enqueue_rolls_back_with_the_job_transaction(db, job):
    # Enqueue as part of an uncommitted unit of work, then roll back.
    ob.enqueue_sync(db, job, "dispatch", commit=False)
    db.rollback()
    rows = db.query(ConnecteamOutbox).filter(ConnecteamOutbox.job_id == job.id).all()
    assert rows == [], "a rolled-back job change must leave no queued sync (no orphan)"


def test_drain_dispatches_once_and_is_then_a_noop(db, job, ct_configured):
    created, _ = ct_configured
    ob.enqueue_sync(db, job, "dispatch", commit=True)
    out = ob.drain_outbox(db)
    assert out["processed"] == 1 and out["failed"] == 0
    db.refresh(job)
    assert job.connecteam_shift_ids == ["sh1"]  # assigned shift created + recorded
    assert len(created) == 1
    # Draining again processes nothing (the row is done).
    out2 = ob.drain_outbox(db)
    assert out2["processed"] == 0
    assert len(created) == 1, "a processed intent must not create a second shift"


def test_drain_remove_pulls_shifts(db, job, ct_configured):
    _, deleted = ct_configured
    job.connecteam_shift_ids = ["sh_old"]
    db.commit()
    ob.enqueue_sync(db, job, "remove", commit=True)
    out = ob.drain_outbox(db)
    assert out["processed"] == 1
    db.refresh(job)
    assert job.connecteam_shift_ids == [] and deleted == ["sh_old"]


def test_drain_retries_then_parks_as_failed(db, job, monkeypatch):
    monkeypatch.setattr(ob, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "_log", lambda *a, **k: None)
    monkeypatch.setattr(ca, "create_shift_sync",
                        lambda **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    ob.enqueue_sync(db, job, "dispatch", commit=True)
    row_id = db.query(ConnecteamOutbox).filter(ConnecteamOutbox.job_id == job.id).first().id

    out1 = ob.drain_outbox(db, max_attempts=2)
    assert out1["processed"] == 0 and out1["failed"] == 0  # first failure, still pending
    row = db.query(ConnecteamOutbox).get(row_id)
    assert row.status == "pending" and row.attempts == 1 and "boom" in row.last_error

    out2 = ob.drain_outbox(db, max_attempts=2)
    assert out2["failed"] == 1
    row = db.query(ConnecteamOutbox).get(row_id)
    assert row.status == "failed" and row.attempts == 2
