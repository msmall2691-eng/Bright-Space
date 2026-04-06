"""
Test the website quote pipeline end-to-end:
1. POST /api/booking/submit — simulates maineclean.co form submission
2. POST /api/booking/validate-address — address validation
3. GET /api/intake — verify intake was created with all fields
4. PATCH /api/intake/:id — advance status to reviewed
5. POST /api/quotes — create quote from intake
6. GET /api/quotes — verify quote exists
7. POST /api/quotes/:id/convert-to-job — convert to job
8. GET /api/intake — verify status moved to converted
"""
import sys
import os

# Add the backend dir to path so imports work
sys.path.insert(0, os.path.dirname(__file__))

# Use an in-memory test database
os.environ["DATABASE_URL"] = "sqlite:///./test_pipeline.db"

from database.db import init_db
init_db()

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)
PASS = "\033[92m PASS \033[0m"
FAIL = "\033[91m FAIL \033[0m"
results = []


def check(name, condition, detail=""):
    status = PASS if condition else FAIL
    results.append(condition)
    print(f"  {status} {name}" + (f" — {detail}" if detail and not condition else ""))
    return condition


print("\n=== Website Quote Pipeline Tests ===\n")

# ── 1. Booking Submit (website form) ──────────────────────────────
print("1. POST /api/booking/submit")
booking_payload = {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+12075551234",
    "address": "123 Ocean Ave, Portland, ME 04101",
    "serviceType": "airbnb-turnover",
    "requestedDate": "2026-05-01",
    "property": "Ocean View Cottage",
    "bedrooms": 3,
    "bathrooms": 2,
    "guests": 6,
    "checkIn": "2026-04-28T15:00:00Z",
    "checkOut": "2026-05-01T11:00:00Z",
    "squareFeet": 1800,
    "notes": "Please bring extra linens",
    "turnover": "airbnb",
}
r = client.post("/api/booking/submit", json=booking_payload)
check("Returns 201", r.status_code == 201, f"got {r.status_code}")
data = r.json()
check("success=True", data.get("success") is True)
check("bookingId returned", "bookingId" in data)
check("requestedDate echoed", data.get("requestedDate") == "2026-05-01")
booking_id = data.get("bookingId")
print()

# ── 2. Address validation ──────────────────────────────────────────
print("2. POST /api/booking/validate-address")
r = client.post("/api/booking/validate-address", json={"address": "123 Ocean Ave, Portland, ME 04101"})
check("Returns 200", r.status_code == 200)
check("eligible=True for Maine", r.json().get("eligible") is True)

r2 = client.post("/api/booking/validate-address", json={"address": "456 Broadway, New York, NY 10013"})
check("eligible=False for NYC", r2.json().get("eligible") is False)
print()

# ── 3. Verify intake was created with all fields ──────────────────
print("3. GET /api/intake — verify full record")
r = client.get("/api/intake")
check("Returns 200", r.status_code == 200)
intakes = r.json()
check("At least 1 intake", len(intakes) >= 1)
intake = next((i for i in intakes if i["id"] == booking_id), None)
if intake:
    check("name matches", intake["name"] == "Jane Doe")
    check("email matches", intake["email"] == "jane@example.com")
    check("service_type=str (mapped)", intake["service_type"] == "str")
    check("bathrooms=2", intake.get("bathrooms") == 2)
    check("bedrooms=3", intake.get("bedrooms") == 3)
    check("guests=6", intake.get("guests") == 6)
    check("square_footage=1800", intake.get("square_footage") == 1800)
    check("requested_date set", intake.get("requested_date") == "2026-05-01")
    check("check_in set", intake.get("check_in") is not None)
    check("check_out set", intake.get("check_out") is not None)
    check("property_name set", intake.get("property_name") == "Ocean View Cottage")
    check("status=new", intake["status"] == "new")
    check("client_id set", intake.get("client_id") is not None)
    client_id = intake["client_id"]
else:
    check("Intake found by ID", False, f"booking_id={booking_id} not in intakes")
    client_id = None
print()

# ── 4. Advance to reviewed ────────────────────────────────────────
print("4. PATCH /api/intake/:id — advance to reviewed")
r = client.patch(f"/api/intake/{booking_id}", json={"status": "reviewed"})
check("Returns 200", r.status_code == 200)
check("status=reviewed", r.json().get("status") == "reviewed")
print()

# ── 5. Create quote from intake ───────────────────────────────────
print("5. POST /api/quotes — create quote linked to intake")
quote_payload = {
    "client_id": client_id,
    "intake_id": booking_id,
    "address": "123 Ocean Ave, Portland, ME 04101",
    "service_type": "str",
    "items": [
        {"name": "STR Turnover Clean", "description": "Full turnover clean", "qty": 1, "unit_price": 185},
        {"name": "Linen Service", "description": "Fresh linens", "qty": 1, "unit_price": 45},
    ],
    "tax_rate": 5.5,
    "notes": "Airbnb turnover for Ocean View Cottage",
    "valid_until": "2026-04-20",
}
r = client.post("/api/quotes", json=quote_payload)
check("Returns 201", r.status_code == 201, f"got {r.status_code}")
quote = r.json()
check("quote_number assigned", quote.get("quote_number") is not None)
check("total calculated", quote.get("total") > 0, f"total={quote.get('total')}")
check("intake_id linked", quote.get("intake_id") == booking_id)
expected_subtotal = 185 + 45
expected_tax = round(expected_subtotal * 5.5 / 100, 2)
expected_total = round(expected_subtotal + expected_tax, 2)
check("math correct", quote.get("total") == expected_total, f"expected {expected_total}, got {quote.get('total')}")
quote_id = quote["id"]
print()

# ── 6. Verify intake moved to 'quoted' ────────────────────────────
print("6. GET /api/intake — verify status=quoted")
r = client.get("/api/intake")
intake = next((i for i in r.json() if i["id"] == booking_id), None)
check("intake status=quoted", intake and intake["status"] == "quoted")
print()

# ── 7. Accept quote and convert to job ────────────────────────────
print("7. Accept quote, then POST /api/quotes/:id/convert-to-job")
r = client.patch(f"/api/quotes/{quote_id}", json={"status": "accepted"})
check("Quote accepted", r.json().get("status") == "accepted")

r = client.post(f"/api/quotes/{quote_id}/convert-to-job")
check("Returns 201", r.status_code == 201, f"got {r.status_code}")
job = r.json()
check("job created", "id" in job)
check("job type=str", job.get("job_type") == "str")
check("job has address", job.get("address") == "123 Ocean Ave, Portland, ME 04101")
print()

# ── 8. Verify intake moved to 'converted' ─────────────────────────
print("8. GET /api/intake — verify status=converted")
r = client.get("/api/intake")
intake = next((i for i in r.json() if i["id"] == booking_id), None)
check("intake status=converted", intake and intake["status"] == "converted")
print()

# ── 9. Test webhook endpoint (intake/webhook) ─────────────────────
print("9. POST /api/intake/webhook — legacy webhook format")
webhook_payload = {
    "name": "Bob Smith",
    "email": "bob@example.com",
    "phone": "+12075559999",
    "address": "456 Main St",
    "serviceType": "deep",
    "frequency": "biweekly",
    "sqft": 2200,
    "bathrooms": 3,
    "estimateMin": 220,
    "estimateMax": 280,
    "notes": "Has dogs",
}
r = client.post("/api/intake/webhook", json=webhook_payload)
check("Returns 201", r.status_code == 201, f"got {r.status_code}")
check("success=True", r.json().get("success") is True)
print()

# ── 10. Verify client was created ─────────────────────────────────
print("10. GET /api/clients — verify client created from booking")
r = client.get("/api/clients")
check("Returns 200", r.status_code == 200)
clients_list = r.json()
jane = next((c for c in clients_list if c.get("email") == "jane@example.com"), None)
check("Client 'Jane Doe' created", jane is not None)
if jane:
    check("Client status=lead", jane.get("status") == "lead")
    check("Client source=website", jane.get("source") == "website")
print()

# ── Summary ────────────────────────────────────────────────────────
passed = sum(results)
total = len(results)
print(f"{'='*50}")
if passed == total:
    print(f"\033[92m  ALL {total} TESTS PASSED\033[0m")
else:
    print(f"\033[91m  {passed}/{total} tests passed ({total - passed} failed)\033[0m")
print(f"{'='*50}\n")

sys.exit(0 if passed == total else 1)
