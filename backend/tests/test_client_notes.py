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
