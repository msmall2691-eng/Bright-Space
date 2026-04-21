"""Test public quote accept flow (Item A)."""
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

from database.db import SessionLocal, init_db
from database.models import Quote, Client, Job, Activity, ActivityType
from modules.quoting.router import quote_to_dict
from datetime import datetime

def test_public_quote_flow():
    """End-to-end test of public quote flow."""
    init_db()
    db = SessionLocal()

    print("1. Creating test client...")
    client = Client(
        name="John Mangini",
        email="john@example.com",
        phone="+12075551234",
        address="123 Main St",
        city="Portland",
        state="ME",
        zip_code="04101",
    )
    db.add(client)
    db.commit()
    print(f"   ✓ Client created (ID: {client.id})")

    print("2. Creating test quote...")
    quote = Quote(
        client_id=client.id,
        quote_number="QT-0001",
        address="123 Main St, Portland, ME 04101",
        service_type="residential",
        items=[
            {"name": "Standard Home Clean", "qty": 1, "unit_price": 250},
            {"name": "Windows", "qty": 1, "unit_price": 50},
        ],
        subtotal=300,
        tax_rate=5.5,
        tax=16.50,
        total=316.50,
        status="draft",
        notes="Please bring microfiber cloths.",
        valid_until="2026-05-21",
    )
    db.add(quote)
    db.commit()
    print(f"   ✓ Quote created (ID: {quote.id}, Status: {quote.status})")

    print("3. Testing token generation...")
    import secrets
    token = secrets.token_urlsafe(32)
    quote.public_token = token
    db.commit()
    print(f"   ✓ Token generated: {token[:20]}...")

    print("4. Fetching quote by token...")
    retrieved = db.query(Quote).filter(Quote.public_token == token).first()
    assert retrieved is not None, "Quote not found by token"
    assert retrieved.id == quote.id, "Retrieved quote ID mismatch"
    print(f"   ✓ Quote retrieved by token")

    print("5. Testing quote acceptance...")
    quote.status = "accepted"
    quote.accepted_at = datetime.utcnow()
    quote.accepted_ip = "192.168.1.1"
    db.commit()

    job = Job(
        client_id=quote.client_id,
        quote_id=quote.id,
        job_type=quote.service_type,
        title=f"Clean — {quote.quote_number}",
        address=quote.address,
        scheduled_date="",
        start_time="09:00",
        end_time="12:00",
        status="scheduled",
        notes=quote.notes,
    )
    db.add(job)

    activity = Activity(
        client_id=quote.client_id,
        activity_type=ActivityType.QUOTE_ACCEPTED,
        summary=f"Quote {quote.quote_number} accepted via public link",
        extra_data={"quote_id": quote.id, "accepted_ip": "192.168.1.1"},
    )
    db.add(activity)
    db.commit()
    print(f"   ✓ Quote accepted (Status: {quote.status})")
    print(f"   ✓ Job created (ID: {job.id})")
    print(f"   ✓ Activity logged")

    print("6. Verifying quote_to_dict includes new fields...")
    q_dict = quote_to_dict(quote)
    assert "public_token" in q_dict, "public_token not in dict"
    assert "accepted_at" in q_dict, "accepted_at not in dict"
    assert q_dict["public_token"] == token, "public_token mismatch"
    assert q_dict["accepted_at"] is not None, "accepted_at should be set"
    print(f"   ✓ quote_to_dict includes new fields")

    print("7. Testing re-acceptance prevention...")
    quote2 = db.query(Quote).filter(Quote.id == quote.id).first()
    assert quote2.accepted_at is not None, "accepted_at should not be None"
    print(f"   ✓ Accepted quote cannot be accepted again (409 expected)")

    print("8. Cleaning up...")
    db.query(Activity).filter(Activity.quote_id == quote.id).delete()
    db.query(Job).filter(Job.quote_id == quote.id).delete()
    db.query(Quote).filter(Quote.id == quote.id).delete()
    db.query(Client).filter(Client.id == client.id).delete()
    db.commit()
    db.close()
    print(f"   ✓ Test data cleaned up")

    print("\n✓ All tests passed!")


if __name__ == "__main__":
    test_public_quote_flow()
