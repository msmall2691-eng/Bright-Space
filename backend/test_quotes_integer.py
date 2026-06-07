"""End-to-end test for the integer-aligned quotes domain.

Self-contained: builds a minimal app mounting only the quoting router against an
in-memory SQLite DB, with auth/db dependencies overridden. Covers the full
contract the Quoting UI relies on: create (with computed totals + quote_number),
list/get, PATCH (recompute), send -> public token, public view + accept, and
convert-to-job (which must create a Property and link the Job by integer id).

Run: pytest backend/test_quotes_integer.py  (or: python backend/test_quotes_integer.py)
"""
import os
# A file-based SQLite URL: the app's module-level engine (database.db) configures
# a pool that rejects in-memory's argument set. Each test builds its own isolated
# in-memory engine below; this is only to satisfy that import-time engine.
os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/_test_quotes_import.db")
os.environ.setdefault("JWT_SECRET", "test")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database.models import Base, Client
from database.db import get_db
from modules.quoting.router import router as quoting_router
from modules.auth.router import get_current_user


def _make_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    # Seed a client.
    s = TestingSession()
    c = Client(name="Joanna Fox", first_name="Joanna", last_name="Fox",
               status="active", email="j@example.com")
    s.add(c)
    s.commit()
    client_id = c.id
    s.close()

    def override_get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    class FakeUser:
        id = 1

    app = FastAPI()
    app.include_router(quoting_router, prefix="/api/quotes")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = lambda: FakeUser()
    return TestClient(app), client_id


def test_quote_full_lifecycle():
    api, client_id = _make_client()

    # Create — totals computed server-side, quote_number assigned.
    r = api.post("/api/quotes/", json={
        "client_id": client_id,
        "service_type": "residential",
        "address": "4 Red Barn Cir",
        "items": [{"name": "Deep clean", "qty": 2, "unit_price": 150}],
        "tax_rate": 5.5,
        "valid_until": "2026-12-31",
        "notes": "first quote",
    })
    assert r.status_code == 201, r.text
    q = r.json()
    qid = q["id"]
    assert isinstance(qid, int)
    assert q["quote_number"].startswith("QT-")
    assert q["client_name"] == "Joanna Fox"
    assert (q["subtotal"], q["tax"], q["total"]) == (300.0, 16.5, 316.5)

    # List + get.
    assert api.get("/api/quotes/").json()[0]["id"] == qid
    assert api.get(f"/api/quotes/{qid}").json()["address"] == "4 Red Barn Cir"

    # Patch recomputes money.
    r = api.patch(f"/api/quotes/{qid}", json={
        "items": [{"name": "x", "qty": 1, "unit_price": 100}], "tax_rate": 10,
    })
    assert r.status_code == 200, r.text
    pq = r.json()
    assert (pq["subtotal"], pq["tax"], pq["total"]) == (100.0, 10.0, 110.0)

    # Send -> delivers (email) + public token, then public view + accept.
    # /send now actually delivers, so stub the email path (no real Gmail creds
    # in tests) and pass an explicit recipient.
    from unittest.mock import patch as _patch
    with _patch("modules.quoting.router.QuotePDFService") as _PDF, \
         _patch("modules.quoting.router.QuoteEmailService") as _Email:
        _PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        _Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "e1"}
        r = api.post(f"/api/quotes/{qid}/send", json={"channel": "email", "email": "j@example.com"})
    assert r.status_code == 200, r.text
    assert r.json()["results"]["email"] == "sent"
    token = r.json()["public_token"]
    assert token
    pv = api.get(f"/api/quotes/public/{token}")
    assert pv.status_code == 200 and pv.json()["total"] == 110.0
    ac = api.post(f"/api/quotes/public/{token}/accept",
                  json={"name": "Jo", "email": "j@example.com"})
    assert ac.status_code == 200 and ac.json()["status"] == "accepted"

    # Convert to job — creates a Property and links the Job by integer id.
    r = api.post(f"/api/quotes/{qid}/convert-to-job")
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["quote_id"] == qid
    assert job["property_id"]
    assert job["job_type"] == "residential"


def test_create_requires_existing_client():
    api, _ = _make_client()
    r = api.post("/api/quotes/", json={"client_id": 999999, "items": []})
    assert r.status_code == 404


if __name__ == "__main__":
    test_quote_full_lifecycle()
    test_create_requires_existing_client()
    print("PASS: all quote integer tests")
