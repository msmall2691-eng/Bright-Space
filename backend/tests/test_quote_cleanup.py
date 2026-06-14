"""PR4 cleanup: soft-delete (archive), list exclusion, and the auto-expiry sweep."""
from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Property, Quote, Job, Visit
from modules.quoting.router import delete_quote, list_quotes, _existing_job_for_quote


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Cleanup Test", email="cl@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.rollback()
    job_ids = [j.id for j in db.query(Job).filter(Job.client_id == c.id).all()]
    if job_ids:
        db.query(Visit).filter(Visit.job_id.in_(job_ids)).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_quote(db, c, num, status="sent", valid_until=None):
    q = Quote(client_id=c.id, quote_number=num, title="T", service_type="residential",
              address="1 St", notes="", items=[], subtotal=100, tax_rate=0, tax=0,
              discount=0, total=100, status=status,
              valid_until=valid_until or (date.today() + timedelta(days=30)))
    db.add(q); db.commit(); db.refresh(q)
    return q


def test_delete_soft_archives_and_hides_from_list(ctx):
    db, c = ctx
    q = _mk_quote(db, c, "QT-CL-1")
    out = delete_quote(q.id, db=db)
    assert out["status"] == "archived"
    db.refresh(q)
    assert q.status == "archived" and q.archived_at is not None
    # Default listing for this client excludes archived…
    listed = list_quotes(db=db, client_id=c.id, status=None, limit=100, offset=0)
    assert all(row["id"] != q.id for row in listed)
    # …but it's still there (recoverable) when asked for explicitly.
    archived = list_quotes(db=db, client_id=c.id, status="archived", limit=100, offset=0)
    assert any(row["id"] == q.id for row in archived)


def test_delete_refuses_converted_quote(ctx):
    db, c = ctx
    p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    q = _mk_quote(db, c, "QT-CL-2", status="converted")
    db.add(Job(client_id=c.id, property_id=p.id, quote_id=q.id, job_type="residential",
               title="J", status="scheduled")); db.commit()
    with pytest.raises(HTTPException) as exc:
        delete_quote(q.id, db=db)
    assert exc.value.status_code == 409
    db.refresh(q)
    assert q.status == "converted"   # untouched


def test_permanent_delete_requires_archived_first(ctx):
    db, c = ctx
    from modules.quoting.router import permanently_delete_quote
    q = _mk_quote(db, c, "QT-CL-6", status="sent")
    with pytest.raises(HTTPException) as exc:
        permanently_delete_quote(q.id, db=db)
    assert exc.value.status_code == 409          # must archive before hard delete
    db.refresh(q)
    assert q.status == "sent"                     # untouched


def test_permanent_delete_removes_archived_quote(ctx):
    db, c = ctx
    from modules.quoting.router import delete_quote, permanently_delete_quote
    from database.models import Quote
    q = _mk_quote(db, c, "QT-CL-7", status="sent")
    delete_quote(q.id, db=db)                     # archive
    out = permanently_delete_quote(q.id, db=db)   # then hard delete
    assert out["status"] == "deleted"
    assert db.query(Quote).filter(Quote.id == q.id).first() is None


def test_expiry_sweep_flips_past_due_sent_quotes(ctx):
    db, c = ctx
    past = _mk_quote(db, c, "QT-CL-3", status="sent", valid_until=date.today() - timedelta(days=1))
    future = _mk_quote(db, c, "QT-CL-4", status="sent", valid_until=date.today() + timedelta(days=5))
    accepted = _mk_quote(db, c, "QT-CL-5", status="accepted", valid_until=date.today() - timedelta(days=1))
    from scheduler import quote_expiry_tick
    res = quote_expiry_tick()
    assert res.get("expired", 0) >= 1
    db.refresh(past); db.refresh(future); db.refresh(accepted)
    assert past.status == "expired"        # past-due sent → expired
    assert future.status == "sent"         # still valid → untouched
    assert accepted.status == "accepted"   # terminal status → untouched
