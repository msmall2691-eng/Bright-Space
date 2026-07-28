"""The Connecteam job-match preview (GET /api/settings/connecteam/job-match-preview)
— a read-only dry-run showing how each active property links to a Connecteam Job,
so the operator can confirm names line up and spot unmatched ones.

Hermetic: is_configured + the live Jobs fetch are patched; matching uses the
real resolve_job_id against the seeded cache.
"""
import uuid
from unittest.mock import patch

from database.db import SessionLocal
from database.models import Client, Property
from modules.settings import router as settings_router


def _setup(db):
    client = Client(name=f"Coastal {uuid.uuid4().hex[:6]}", status="active")
    db.add(client); db.commit(); db.refresh(client)
    matched = Property(client_id=client.id, name="Pier House", address="1 Ocean Ave",
                       property_type="short_term_rental", active=True)
    unmatched = Property(client_id=client.id, name="Nowhere Cabin", address="9 Woods Rd",
                         property_type="short_term_rental", active=True)
    db.add_all([matched, unmatched]); db.commit()
    return client, matched, unmatched


def _cleanup(db, client):
    db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()


def test_preview_not_configured_is_empty():
    db = SessionLocal()
    try:
        with patch("integrations.connecteam.is_configured", return_value=False):
            out = settings_router.connecteam_job_match_preview(db)
        assert out["configured"] is False
        assert out["properties"] == [] and out["matched"] == 0
    finally:
        db.close()


def test_preview_reports_matched_and_unmatched():
    db = SessionLocal()
    try:
        client, matched, unmatched = _setup(db)
        jobs = {"J1": {"name": "Pier House", "code": "PH"}}
        with patch("integrations.connecteam.is_configured", return_value=True), \
             patch("integrations.connecteam.get_jobs_sync", return_value=jobs):
            out = settings_router.connecteam_job_match_preview(db)

        assert out["configured"] is True
        assert out["job_count"] == 1
        by_prop = {r["property"]: r for r in out["properties"]}
        assert by_prop["Pier House"]["matched_job_id"] == "J1"
        assert by_prop["Pier House"]["matched_job_name"] == "Pier House"
        assert by_prop["Nowhere Cabin"]["matched_job_id"] is None
        # Counts reflect only the two props we created (others may exist in the
        # shared test DB, so assert our rows rather than the global totals).
        assert out["matched"] >= 1 and out["unmatched"] >= 1
    finally:
        _cleanup(db, client); db.close()
