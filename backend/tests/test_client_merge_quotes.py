"""Regression: merging two clients must MOVE the loser's quotes to the winner,
not silently delete them.

Quote.client_id is an integer FK with ondelete=CASCADE and Client.quotes is
cascade="all, delete-orphan" — so if the merge doesn't re-parent quotes before
deleting the loser, the loser's quotes are destroyed. A stale docstring used to
claim quotes were UUID-keyed and untouched; they aren't.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7631, 1, "admin", "active", True
    email = "merge-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_merge_moves_loser_quotes_to_winner(api):
    db = SessionLocal()
    try:
        winner = Client(name=f"Winner {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        loser = Client(name=f"Loser {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        db.add_all([winner, loser]); db.commit()
        db.refresh(winner); db.refresh(loser)
        winner_id, loser_id = winner.id, loser.id

        q = Quote(client_id=loser_id, quote_number=f"Q-{uuid.uuid4().hex[:8]}",
                  status="sent", service_type="residential", total=250, org_id=1,
                  public_token=uuid.uuid4().hex)
        db.add(q); db.commit(); db.refresh(q)
        quote_id = q.id

        r = api.post(f"/api/clients/{winner_id}/merge", json={"loser_id": loser_id})
        assert r.status_code == 200, r.text

        db.expire_all()
        moved = db.query(Quote).filter(Quote.id == quote_id).first()
        assert moved is not None, "the quote was DELETED by the merge (data loss)"
        assert moved.client_id == winner_id, "the quote should now belong to the winner"
        # Loser is gone.
        assert db.query(Client).filter(Client.id == loser_id).first() is None
    finally:
        # Clean up: quote + winner (loser already deleted by merge).
        db.query(Quote).filter(Quote.client_id == winner_id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id.in_([winner_id, loser_id])).delete(synchronize_session=False)
        db.commit(); db.close()
