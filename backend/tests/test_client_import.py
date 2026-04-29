import io
import pytest
from fastapi.testclient import TestClient
from main import app
from database.models import Client
from database.db import SessionLocal

client = TestClient(app)


def test_import_clients_valid_csv_dry_run():
    """Test importing valid clients in dry-run mode."""
    csv_content = """Client Name,Status,Phone,Email,Created date,Tags
Alice Smith,Active,(207) 555-1234,alice@example.com,2025-01-01,Residential
Bob Johnson,Active,+12015551234,bob@example.com,2025-01-02,"""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "true"},
        files={"file": ("test.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "dry_run"
    assert data["preview"]["valid_clients"] == 2
    assert data["preview"]["clients_to_create"] == 2
    assert len(data["preview"]["sample_clients"]) == 2


def test_import_clients_phone_normalization():
    """Test that phone numbers are normalized to E.164."""
    csv_content = """Client Name,Status,Phone,Email
Charlie Brown,Active,(603) 539-5946,charlie@example.com
Diana Chen,Active,2075555555,diana@example.com
Edward Davis,Active,+14109912263,edward@example.com"""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "true"},
        files={"file": ("test.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    clients = data["preview"]["sample_clients"]

    # Check phone normalization
    assert clients[0]["phone"] == "+16035395946"  # (603) 539-5946 → +16035395946
    assert clients[1]["phone"] == "+12075555555"  # 2075555555 → +12075555555
    assert clients[2]["phone"] == "+14109912263"  # already E.164


def test_import_clients_duplicate_detection():
    """Test that duplicates in CSV are detected."""
    csv_content = """Client Name,Status,Phone,Email
Alice Smith,Active,(207) 555-1234,alice@example.com
Alice Smith,Active,(207) 555-1234,alice.smith@example.com"""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "true"},
        files={"file": ("test.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["preview"]["duplicates_in_csv"] == 1
    assert len(data["preview"]["duplicates"]) == 1
    assert data["preview"]["clients_to_create"] == 1  # only one created, one skipped


def test_import_clients_skip_internal_entries():
    """Test that internal/system entries are skipped."""
    csv_content = """Client Name,Status,Phone,Email
Unit inventory and maintaince,Active,,
The Maine Cleaning Co. – Team Resources,Active,2075034702,
Valid Client,Active,(207) 555-1234,valid@example.com"""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "true"},
        files={"file": ("test.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["preview"]["valid_clients"] == 1
    assert data["preview"]["invalid_count"] == 2
    assert len(data["preview"]["invalid_rows"]) == 2


def test_import_clients_missing_name():
    """Test that rows with missing client name are marked invalid."""
    csv_content = """Client Name,Status,Phone,Email
,Active,2075551234,blank@example.com
Valid Name,Active,2075551235,valid@example.com"""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "true"},
        files={"file": ("test.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["preview"]["invalid_count"] == 1
    assert len(data["preview"]["invalid_rows"]) == 1
    assert data["preview"]["valid_clients"] == 1


def test_import_clients_apply_mode():
    """Test that apply mode creates clients in database."""
    # Clean up any test clients first
    db = SessionLocal()
    db.query(Client).filter(Client.name == "Test Client Apply").delete()
    db.commit()
    db.close()

    csv_content = """Client Name,Status,Phone,Email
Test Client Apply,Active,(207) 555-9999,test.apply@example.com"""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "false"},
        files={"file": ("test.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "apply"
    assert data["result"]["created"] == 1

    # Verify client was created
    db = SessionLocal()
    new_client = db.query(Client).filter(Client.name == "Test Client Apply").first()
    assert new_client is not None
    assert new_client.email == "test.apply@example.com"
    assert new_client.phone == "+12075559999"
    db.close()


def test_import_clients_invalid_file_format():
    """Test that non-CSV files are rejected."""
    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "true"},
        files={"file": ("test.txt", io.BytesIO(b"not a csv"), "text/plain")}
    )

    assert response.status_code == 400
    assert "CSV format" in response.json()["detail"]


def test_import_clients_with_real_data():
    """Test with sample data from the actual Jobber export."""
    csv_content = """Client Name,Status,Lead source,Phone,Email,Created date,Tags,Payment method on file
Alex Huang,Active,,8455059326,alexhyy0313@gmail.com,2025-05-10,Residential,""
Alexis McCoy,Active,,+12026808327,alexisjmccoy@gmail.com,2025-06-26,"",""
Alyssa Laflamme,Active,Alyssa,207-756-4056,alyssalaflamme92@gmail.com,2025-10-09,"",""
Beth Terry,Active,,4107032161,bethduga@gmail.com,2025-05-03,Residential,""
Brian Shimko,Active,Facebook,(203) 733-3915,bshim88@gmail.com,2026-03-16,"",""
Unit inventory and maintaince,Active,,,,2025-04-23,"",""
👉 The Maine Cleaning Co. – Team Resources,Active,,2075034702,,2025-09-15,"","""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "true"},
        files={"file": ("jobber-export.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    # Should have 5 valid clients (internal entries excluded)
    assert data["preview"]["valid_clients"] == 5
    # Should skip 2 internal entries
    assert data["preview"]["invalid_count"] == 2
    assert len(data["preview"]["invalid_rows"]) == 2

    # Check phone normalization on real data
    clients = data["preview"]["sample_clients"]
    assert any(c["phone"] == "+18455059326" for c in clients)  # 8455059326
    assert any(c["phone"] == "+12026808327" for c in clients)  # +12026808327
    assert any(c["phone"] == "+12077564056" for c in clients)  # 207-756-4056


def test_import_clients_apply_skips_existing_with_formatted_phone():
    """Regression test for Codex P1 finding: apply mode must compare normalized phones.

    If a client exists in DB with normalized E.164 phone, and the CSV has the same
    number in formatted display form (e.g. (207) 555-1234), the apply mode must
    correctly skip it instead of creating a duplicate.
    """
    # Setup: pre-create a client with normalized phone
    db = SessionLocal()
    db.query(Client).filter(Client.name == "Existing Phone Match").delete()
    pre_existing = Client(
        name="Existing Phone Match",
        phone="+12075558888",
        phone_tail="2075558888",
        email="existing.match@example.com",
        status="active",
    )
    db.add(pre_existing)
    db.commit()
    db.close()

    # CSV has the same phone in formatted form
    csv_content = """Client Name,Status,Phone,Email
Existing Phone Match,Active,(207) 555-8888,different.email@example.com"""

    response = client.post(
        "/api/admin/import/clients",
        params={"dry_run": "false"},
        files={"file": ("test.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    )

    assert response.status_code == 200
    data = response.json()
    # Should skip (not create) since the phone matches the existing record
    assert data["result"]["created"] == 0
    assert data["result"]["skipped"] == 1

    # Cleanup
    db = SessionLocal()
    db.query(Client).filter(Client.name == "Existing Phone Match").delete()
    db.commit()
    db.close()
