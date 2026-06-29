"""Quote-request endpoints now write to lead_intakes (source='quote_request').

The QuoteRequest table was retired in favor of LeadIntake — the two modeled the
same thing. This test pins down the consolidated POST/GET/PUT /api/quotes/requests/
behavior so the same external API shape keeps working.
"""
from datetime import date

from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake


client = TestClient(app)


def _seed_request(**overrides):
    payload = {
        "requester_name": "Web Submitter",
        "requester_email": "web@example.com",
        "requester_phone": "2075551111",
        "service_type": "residential",
        "description": "Biweekly please",
        "preferred_date": date(2026, 7, 15).isoformat(),
        "preferred_time": "morning",
    }
    payload.update(overrides)
    res = client.post("/api/quotes/requests/", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def _cleanup(ids):
    db = SessionLocal()
    try:
        if ids:
            db.query(LeadIntake).filter(LeadIntake.id.in_(ids)).delete(
                synchronize_session=False
            )
            db.commit()
    finally:
        db.close()


def test_create_writes_lead_intake_tagged_as_quote_request():
    created = _seed_request()
    try:
        assert created["status"] == "new"  # remapped from old 'pending'
        assert created["requester_name"] == "Web Submitter"

        db = SessionLocal()
        try:
            row = db.query(LeadIntake).filter(LeadIntake.id == created["id"]).one()
            # The web form's fields landed on the canonical intake columns,
            # and provenance is preserved on `source` so list-by-source works.
            assert row.source == "quote_request"
            assert row.name == "Web Submitter"
            assert row.email == "web@example.com"
            assert row.phone == "2075551111"
            assert row.message == "Biweekly please"
            assert row.preferred_date == "2026-07-15"
            assert row.preferred_time == "morning"
        finally:
            db.close()
    finally:
        _cleanup([created["id"]])


def test_list_only_returns_quote_request_intakes_and_filters_by_status():
    qr = _seed_request(requester_email="qr@example.com")
    # A non-quote-request lead intake — must NOT appear in the requests list.
    db = SessionLocal()
    try:
        unrelated = LeadIntake(
            name="Website Lead", email="lead@example.com", source="website",
            status="new",
        )
        db.add(unrelated); db.commit(); db.refresh(unrelated)
        unrelated_id = unrelated.id
    finally:
        db.close()

    try:
        # No frontend authentication in tests — the require_role dep is a no-op
        # without a JWT, so the GET is reachable.
        res = client.get("/api/quotes/requests/")
        assert res.status_code == 200, res.text
        ids = [row["id"] for row in res.json()]
        assert qr["id"] in ids
        assert unrelated_id not in ids  # source filter excludes plain leads

        # Status filter (new vocabulary, not 'pending') passes through.
        res = client.get("/api/quotes/requests/?status=new")
        assert res.status_code == 200, res.text
        assert qr["id"] in [r["id"] for r in res.json()]

        res = client.get("/api/quotes/requests/?status=archived")
        assert res.status_code == 200, res.text
        assert qr["id"] not in [r["id"] for r in res.json()]
    finally:
        _cleanup([qr["id"], unrelated_id])


def test_update_translates_public_fields_onto_lead_intake_columns():
    created = _seed_request(requester_email="update@example.com")
    try:
        res = client.put(
            f"/api/quotes/requests/{created['id']}",
            json={"status": "reviewed", "description": "Updated note"},
        )
        # Note: PUT route has no trailing slash (matches router decorator).
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["status"] == "reviewed"

        db = SessionLocal()
        try:
            row = db.query(LeadIntake).filter(LeadIntake.id == created["id"]).one()
            # Public 'description' wrote to LeadIntake.message; status passed through.
            assert row.message == "Updated note"
            assert row.status == "reviewed"
            # The lead intake retains its provenance tag after edits.
            assert row.source == "quote_request"
        finally:
            db.close()
    finally:
        _cleanup([created["id"]])


def test_update_unknown_id_returns_404():
    res = client.put("/api/quotes/requests/99999999", json={"status": "archived"})
    assert res.status_code == 404
