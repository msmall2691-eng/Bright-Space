"""
End-to-end workflow test: maineclean.co request -> BrightBase -> quote & schedule via SMS/email.

Tests the FULL pipeline:
  1. Customer submits request on www.maineclean.co (booking form)
  2. Webhook/intake lands in BrightBase pipeline
  3. Address validation confirms service area
  4. Operator reviews intake, creates a quote
  5. Quote is sent to client via EMAIL
  6. Quote is sent to client via SMS
  7. Client accepts -> quote converted to scheduled job
  8. Job schedule confirmation sent via SMS
  9. Message audit trail is verified

External services (Twilio SMS, Gmail SMTP) are mocked so the test runs without credentials.
"""

import sys
import os
from unittest.mock import patch, MagicMock

# Setup
sys.path.insert(0, os.path.dirname(__file__))
os.environ["DATABASE_URL"] = "sqlite:///./test_maineclean_workflow.db"

# Remove stale test DB if present
db_path = os.path.join(os.path.dirname(__file__), "test_maineclean_workflow.db")
if os.path.exists(db_path):
    os.remove(db_path)

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
    print(f"  {status} {name}" + (f" -- {detail}" if detail and not condition else ""))
    return condition


print()
print("=" * 60)
print("  maineclean.co -> BrightBase Full Workflow Test")
print("  (SMS + Email sending included, with mocked services)")
print("=" * 60)
print()


# ============================================================================
# STEP 1: Customer submits booking on www.maineclean.co
# ============================================================================
print("STEP 1: POST /api/booking/submit (maineclean.co form)")
print("-" * 50)

booking_payload = {
    "name": "Sarah Thompson",
    "email": "sarah@example.com",
    "phone": "+12075551234",
    "address": "42 Lighthouse Way, Cape Elizabeth, ME 04107",
    "serviceType": "residential-cleaning",
    "requestedDate": "2026-04-15",
    "bedrooms": 4,
    "bathrooms": 3,
    "squareFeet": 2400,
    "notes": "Two dogs, please use pet-safe products",
}
r = client.post("/api/booking/submit", json=booking_payload)
check("Returns 201", r.status_code == 201, f"got {r.status_code}")
data = r.json()
check("success=True", data.get("success") is True)
check("bookingId returned", "bookingId" in data)
booking_id = data.get("bookingId")
print()


# ============================================================================
# STEP 2: Also test the webhook (InstantEstimate) path from maineclean.co
# ============================================================================
print("STEP 2: POST /api/intake/webhook (InstantEstimate widget)")
print("-" * 50)

webhook_payload = {
    "name": "Sarah Thompson",
    "email": "sarah@example.com",
    "phone": "+12075551234",
    "address": "42 Lighthouse Way, Cape Elizabeth, ME 04107",
    "serviceType": "standard",
    "frequency": "biweekly",
    "sqft": 2400,
    "bathrooms": 3,
    "petHair": "heavy",
    "condition": "good",
    "estimateMin": 195,
    "estimateMax": 245,
    "notes": "Two dogs, pet-safe products please",
}
r = client.post("/api/intake/webhook", json=webhook_payload)
check("Returns 201", r.status_code == 201, f"got {r.status_code}")
check("success=True", r.json().get("success") is True)
webhook_intake_id = r.json().get("intake_id")
print()


# ============================================================================
# STEP 3: Address validation
# ============================================================================
print("STEP 3: POST /api/booking/validate-address")
print("-" * 50)

r = client.post("/api/booking/validate-address", json={"address": "42 Lighthouse Way, Cape Elizabeth, ME 04107"})
check("Maine address eligible", r.json().get("eligible") is True)

r2 = client.post("/api/booking/validate-address", json={"address": "100 Park Ave, New York, NY 10001"})
check("Non-Maine address rejected", r2.json().get("eligible") is False)
print()


# ============================================================================
# STEP 4: Verify intake in pipeline & get client_id
# ============================================================================
print("STEP 4: GET /api/intake -- verify in pipeline")
print("-" * 50)

r = client.get("/api/intake")
intakes = r.json()
intake = next((i for i in intakes if i["id"] == booking_id), None)
check("Intake found in pipeline", intake is not None)
check("status=new", intake and intake["status"] == "new")
check("service_type=residential", intake and intake["service_type"] == "residential")
check("square_footage=2400", intake and intake.get("square_footage") == 2400)
check("client_id assigned", intake and intake.get("client_id") is not None)
client_id = intake["client_id"] if intake else None
print()


# ============================================================================
# STEP 5: Operator reviews intake -> status=reviewed
# ============================================================================
print("STEP 5: PATCH /api/intake/:id -- advance to reviewed")
print("-" * 50)

r = client.patch(f"/api/intake/{booking_id}", json={"status": "reviewed"})
check("Returns 200", r.status_code == 200)
check("status=reviewed", r.json().get("status") == "reviewed")
print()


# ============================================================================
# STEP 6: Create a quote from the intake
# ============================================================================
print("STEP 6: POST /api/quotes -- create quote")
print("-" * 50)

quote_payload = {
    "client_id": client_id,
    "intake_id": booking_id,
    "address": "42 Lighthouse Way, Cape Elizabeth, ME 04107",
    "service_type": "residential",
    "items": [
        {"name": "Deep Clean (4 bed / 3 bath)", "description": "Full deep clean, 2400 sqft", "qty": 1, "unit_price": 220},
        {"name": "Pet Treatment Add-on", "description": "Pet-safe products, extra vacuuming", "qty": 1, "unit_price": 35},
    ],
    "tax_rate": 5.5,
    "notes": "Biweekly service. Two dogs -- pet-safe products used. Estimate range: $195-$245.",
    "valid_until": "2026-04-30",
}
r = client.post("/api/quotes", json=quote_payload)
check("Returns 201", r.status_code == 201, f"got {r.status_code}")
quote = r.json()
check("quote_number assigned", quote.get("quote_number") is not None)
quote_id = quote["id"]
q_num = quote["quote_number"]

# Verify math: subtotal = 220 + 35 = 255, tax = 255 * 5.5% = 14.03, total = 269.03
expected_subtotal = 255.0
expected_tax = round(255.0 * 5.5 / 100, 2)  # 14.03
expected_total = round(expected_subtotal + expected_tax, 2)  # 269.03
check(f"subtotal={expected_subtotal}", quote.get("subtotal") == expected_subtotal, f"got {quote.get('subtotal')}")
check(f"tax={expected_tax}", quote.get("tax") == expected_tax, f"got {quote.get('tax')}")
check(f"total={expected_total}", quote.get("total") == expected_total, f"got {quote.get('total')}")
check("intake_id linked", quote.get("intake_id") == booking_id)

# Verify intake moved to quoted
r = client.get("/api/intake")
intake = next((i for i in r.json() if i["id"] == booking_id), None)
check("intake status=quoted", intake and intake["status"] == "quoted")
print()


# ============================================================================
# STEP 7: SEND QUOTE VIA EMAIL (mocked SMTP)
# ============================================================================
print("STEP 7: POST /api/quotes/:id/send -- send via EMAIL")
print("-" * 50)

with patch("integrations.email.smtplib.SMTP") as mock_smtp:
    # Mock the SMTP server
    mock_server = MagicMock()
    mock_smtp.return_value.__enter__ = MagicMock(return_value=mock_server)
    mock_smtp.return_value.__exit__ = MagicMock(return_value=False)

    # Set env vars for email
    os.environ["SMTP_USER"] = "hello@maineclean.co"
    os.environ["SMTP_PASS"] = "test-app-password"
    os.environ["FROM_EMAIL"] = "hello@maineclean.co"
    os.environ["FROM_NAME"] = "Maine Cleaning Co"

    r = client.post(f"/api/quotes/{quote_id}/send", json={
        "channel": "email",
        "email": "sarah@example.com",
    })
    check("Returns 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
    resp = r.json()
    check("email=sent", resp.get("results", {}).get("email") == "sent", f"got {resp}")
    check("quote status=sent", resp.get("status") == "sent")
    check("SMTP server called", mock_smtp.called or mock_server.sendmail.called)
print()


# ============================================================================
# STEP 8: SEND QUOTE VIA SMS (mocked Twilio)
# ============================================================================
print("STEP 8: POST /api/quotes/:id/send -- send via SMS")
print("-" * 50)

# Reset quote status to draft so we can test SMS send
client.patch(f"/api/quotes/{quote_id}", json={"status": "draft"})

with patch("integrations.twilio_client.Client") as mock_twilio_class:
    mock_twilio_instance = MagicMock()
    mock_twilio_class.return_value = mock_twilio_instance
    mock_message = MagicMock()
    mock_message.sid = "SM_TEST_12345"
    mock_message.status = "queued"
    mock_twilio_instance.messages.create.return_value = mock_message

    os.environ["TWILIO_ACCOUNT_SID"] = "AC_TEST"
    os.environ["TWILIO_AUTH_TOKEN"] = "test_token"
    os.environ["TWILIO_PHONE_NUMBER"] = "+12075550000"

    r = client.post(f"/api/quotes/{quote_id}/send", json={
        "channel": "sms",
        "phone": "+12075551234",
        "custom_message": "Hi Sarah! Here's your quote for biweekly cleaning:",
    })
    check("Returns 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
    resp = r.json()
    check("sms=sent", resp.get("results", {}).get("sms") == "sent", f"got {resp}")
    check("Twilio create() called", mock_twilio_instance.messages.create.called)

    # Verify the SMS body contains the quote details
    if mock_twilio_instance.messages.create.called:
        call_kwargs = mock_twilio_instance.messages.create.call_args
        sms_body = call_kwargs.kwargs.get("body", "") if call_kwargs.kwargs else call_kwargs[1].get("body", "")
        check("SMS contains quote number", q_num in sms_body, f"body={sms_body[:80]}...")
        check("SMS contains total", f"${expected_total}" in sms_body, f"body={sms_body[:80]}...")
        check("SMS contains custom message", "Hi Sarah" in sms_body)
print()


# ============================================================================
# STEP 9: Client accepts -> convert quote to scheduled job
# ============================================================================
print("STEP 9: Accept quote & convert to job")
print("-" * 50)

r = client.patch(f"/api/quotes/{quote_id}", json={"status": "accepted"})
check("Quote accepted", r.json().get("status") == "accepted")

# Convert to job (mock GCal since it's called on job creation)
with patch("integrations.google_calendar.create_event", return_value=None):
    r = client.post(f"/api/quotes/{quote_id}/convert-to-job")
    check("Returns 201", r.status_code == 201, f"got {r.status_code}")
    job = r.json()
    check("job created", "id" in job)
    check("job type=residential", job.get("job_type") == "residential")
    check("job has address", "Cape Elizabeth" in (job.get("address") or ""))
    job_id = job["id"]

# Set the job schedule
r = client.patch(f"/api/jobs/{job_id}", json={
    "scheduled_date": "2026-04-15",
    "start_time": "10:00",
    "end_time": "13:00",
    "status": "scheduled",
})
check("Job scheduled", r.json().get("scheduled_date") == "2026-04-15")
check("Job status=scheduled", r.json().get("status") == "scheduled")
print()


# ============================================================================
# STEP 10: Send schedule confirmation via SMS
# ============================================================================
print("STEP 10: POST /api/comms/sms -- schedule confirmation SMS")
print("-" * 50)

with patch("integrations.twilio_client.Client") as mock_twilio_class:
    mock_twilio_instance = MagicMock()
    mock_twilio_class.return_value = mock_twilio_instance
    mock_message = MagicMock()
    mock_message.sid = "SM_TEST_67890"
    mock_message.status = "queued"
    mock_twilio_instance.messages.create.return_value = mock_message

    confirmation_msg = (
        "Hi Sarah! Your cleaning with Maine Cleaning Co is confirmed:\n"
        "Date: April 15, 2026\n"
        "Time: 10:00 AM - 1:00 PM\n"
        "Address: 42 Lighthouse Way, Cape Elizabeth, ME 04107\n"
        "Service: Deep Clean + Pet Treatment\n"
        "Total: $269.03\n\n"
        "Reply with any questions. See you then!"
    )

    r = client.post("/api/comms/sms", json={
        "to": "+12075551234",
        "body": confirmation_msg,
        "client_id": client_id,
    })
    check("Returns 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
    msg_data = r.json()
    check("Message logged", msg_data.get("id") is not None)
    check("channel=sms", msg_data.get("channel") == "sms")
    check("direction=outbound", msg_data.get("direction") == "outbound")
    check("Twilio called", mock_twilio_instance.messages.create.called)
print()


# ============================================================================
# STEP 11: Verify intake moved to 'converted'
# ============================================================================
print("STEP 11: GET /api/intake -- verify status=converted")
print("-" * 50)

r = client.get("/api/intake")
intake = next((i for i in r.json() if i["id"] == booking_id), None)
check("intake status=converted", intake and intake["status"] == "converted")
print()


# ============================================================================
# STEP 12: Verify message audit trail
# ============================================================================
print("STEP 12: GET /api/comms/messages -- verify audit trail")
print("-" * 50)

r = client.get(f"/api/comms/messages?client_id={client_id}")
check("Returns 200", r.status_code == 200)
messages = r.json()
check("Messages logged", len(messages) >= 2, f"found {len(messages)} messages")

# Check for email message
email_msgs = [m for m in messages if m["channel"] == "email"]
check("Email message in audit trail", len(email_msgs) >= 1)
if email_msgs:
    check("Email has subject with quote#", q_num in (email_msgs[0].get("subject") or ""))

# Check for SMS messages
sms_msgs = [m for m in messages if m["channel"] == "sms"]
check("SMS messages in audit trail", len(sms_msgs) >= 1, f"found {len(sms_msgs)} SMS messages")
print()


# ============================================================================
# STEP 13: Verify client record is complete
# ============================================================================
print("STEP 13: GET /api/clients -- verify client record")
print("-" * 50)

r = client.get("/api/clients")
clients_list = r.json()
sarah = next((c for c in clients_list if c.get("email") == "sarah@example.com"), None)
check("Client exists", sarah is not None)
if sarah:
    check("name=Sarah Thompson", sarah.get("name") == "Sarah Thompson")
    check("phone set", sarah.get("phone") == "+12075551234")
    check("source=website", sarah.get("source") == "website")
    check("No duplicate clients", sum(1 for c in clients_list if c.get("email") == "sarah@example.com") == 1)
print()


# ============================================================================
# SUMMARY
# ============================================================================
passed = sum(results)
total = len(results)
print("=" * 60)
if passed == total:
    print(f"\033[92m  ALL {total} TESTS PASSED\033[0m")
    print()
    print("  Workflow verified:")
    print("    maineclean.co form -> intake pipeline -> quote")
    print("    -> send via EMAIL -> send via SMS -> accept")
    print("    -> scheduled job -> confirmation SMS -> audit trail")
else:
    print(f"\033[91m  {passed}/{total} tests passed ({total - passed} FAILED)\033[0m")
print("=" * 60)
print()

# Cleanup
if os.path.exists(db_path):
    os.remove(db_path)

sys.exit(0 if passed == total else 1)
