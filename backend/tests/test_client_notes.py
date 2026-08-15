"""Internal notes on a client should land in the unified timeline even when the
client has no SMS/email conversation. POST /api/clients/{id}/notes records a
NOTE_ADDED activity anchored to the client.
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Activity, ActivityType
from modules.clients.router import add_client_note, ClientNoteRequest


class _FakeUser:
    email = "owner@example.com"
    role = "admin"


@pytest.fixture
def client_row():
    db = SessionLocal()
    c = Client(name="Note Target", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_add_note_creates_activity(client_row):
    db, c = client_row
    out = add_client_note(c.id, ClientNoteRequest(body="  Gate code is 1234  "),
                          db=db, current_user=_FakeUser())
    assert out["activity_type"] == ActivityType.NOTE_ADDED.value
    assert out["summary"] == "Gate code is 1234"  # trimmed
    assert out["actor"] == "owner@example.com"
    row = db.query(Activity).filter(Activity.id == out["id"]).one()
    assert row.activity_type == ActivityType.NOTE_ADDED.value and row.client_id == c.id


def test_blank_note_rejected(client_row):
    db, c = client_row
    with pytest.raises(Exception):
        add_client_note(c.id, ClientNoteRequest(body="   "), db=db, current_user=_FakeUser())
    assert db.query(Activity).filter(Activity.client_id == c.id).count() == 0


def test_unknown_client_404(client_row):
    db, c = client_row
    with pytest.raises(Exception):
        add_client_note(999999, ClientNoteRequest(body="hi"), db=db, current_user=_FakeUser())


def test_delete_guards_history_and_paid_invoices():
    """BB-SEC-09/10: a client with real history and a paid invoice both 409
    without force=True — the cascade/payment-record erasure needs an explicit
    informed yes, from ANY caller, not just the UI's confirm dialog."""
    from fastapi import HTTPException
    from database.models import Job, Invoice, Property
    from modules.clients.router import delete_client
    from modules.invoicing.router import delete_invoice

    db = SessionLocal()
    c = Client(name="Guard Test Client", email="guard@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="1 Test St", address="1 Test St")
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Guard Test Clean",
            job_type="residential", status="completed")
    inv = Invoice(client_id=c.id, status="paid", total=100)
    db.add_all([j, inv]); db.commit(); db.refresh(j); db.refresh(inv)
    try:
        # Client with history: refused without force, with counts in the detail.
        with pytest.raises(HTTPException) as ei:
            delete_client(c.id, force=False, db=db, org_id=None)
        assert ei.value.status_code == 409
        assert ei.value.detail["code"] == "client_has_history"
        counts = ei.value.detail["counts"]
        assert counts["jobs"] >= 1 and counts["invoices"] >= 1

        # Paid invoice: refused without force; force deletes.
        with pytest.raises(HTTPException) as ei:
            delete_invoice(inv.id, force=False, db=db, org_id=None)
        assert ei.value.status_code == 409
        assert ei.value.detail["code"] == "invoice_paid"
        delete_invoice(inv.id, force=True, db=db, org_id=None)
        assert db.query(Invoice).filter(Invoice.id == inv.id).first() is None

        # Forced client delete goes through (cascades the job).
        delete_client(c.id, force=True, db=db, org_id=None)
        assert db.query(Client).filter(Client.id == c.id).first() is None
    finally:
        # FK-safe cleanup for any rows a failed assertion left behind.
        db.rollback()
        db.query(Invoice).filter(Invoice.id == inv.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
