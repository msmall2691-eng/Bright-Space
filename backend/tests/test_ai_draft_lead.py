"""AI-draft a first reply to a new lead/request. With no ANTHROPIC_API_KEY in
CI, this exercises the deterministic fallback and the {subject, message} shape;
the email path carries a subject, the SMS path doesn't."""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, LeadIntake, Conversation
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7601, 1, "admin", "active", True
    email = "ai-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_draft_lead_reply_email_and_sms(api):
    db = SessionLocal()
    intake = LeadIntake(name="Dana Lead", email="dana@example.com", phone="+12075550111",
                        service_type="residential", frequency="biweekly",
                        message="Looking for biweekly cleaning of my 3 bedroom home.",
                        city="Portland", state="ME", source="website", org_id=1, status="new")
    db.add(intake); db.commit(); iid = intake.id
    db.close()
    try:
        r = api.post(f"/api/ai/draft-lead-reply/{iid}", json={"channel": "email"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("message")           # non-empty draft
        assert body.get("subject")           # email carries a subject
        assert "Dana" in body["message"]     # personalized by first name

        r2 = api.post(f"/api/ai/draft-lead-reply/{iid}", json={"channel": "sms"})
        assert r2.status_code == 200, r2.text
        sms = r2.json()
        assert sms.get("message")
        assert sms.get("subject") == ""      # SMS has no subject
    finally:
        db = SessionLocal()
        db.query(LeadIntake).filter(LeadIntake.id == iid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_draft_lead_reply_404(api):
    r = api.post("/api/ai/draft-lead-reply/999999", json={"channel": "email"})
    assert r.status_code == 200
    assert r.json().get("error")


def test_quote_from_conversation(api):
    """Without an ANTHROPIC key the extractor no-ops, but the endpoint must
    still return an intake-shaped, priced object the quote form can open."""
    db = SessionLocal()
    c = Client(name="Cabin Lead", email="cabin@example.com", phone="+12075550222",
               status="lead", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    client_id = c.id
    conv = Conversation(client_id=client_id, channel="email", status="open", org_id=1)
    db.add(conv); db.commit(); cid = conv.id
    db.close()
    try:
        r = api.post(f"/api/ai/quote-from-conversation/{cid}", json={})
        assert r.status_code == 200, r.text
        body = r.json()
        assert not body.get("error")
        assert body["from_conversation_id"] == cid
        assert body["name"] == "Cabin Lead"
        assert body["email"] == "cabin@example.com"
        assert body["requested_service"]                 # always a service key
        assert isinstance(body["estimate_min"], int)     # priced by the engine
        assert body["estimate_max"] >= body["estimate_min"]
    finally:
        db = SessionLocal()
        db.query(Conversation).filter(Conversation.id == cid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_quote_from_conversation_404(api):
    r = api.post("/api/ai/quote-from-conversation/999999", json={})
    assert r.status_code == 200
    assert r.json().get("error")


def test_enrich_lead(api):
    """Without an API key, enrich returns a deterministic {summary, next_action,
    tags} card so the insight strip is still useful."""
    db = SessionLocal()
    intake = LeadIntake(name="Enrich Lead", email="e@example.com",
                        service_type="residential", requested_service="deep",
                        frequency="one-time", city="Portland", state="ME",
                        message="Need a deep clean before move-in.",
                        square_footage=1800, status="new", priority="high",
                        source="website", org_id=1)
    db.add(intake); db.commit(); iid = intake.id
    db.close()
    try:
        r = api.post(f"/api/ai/enrich/lead/{iid}", json={})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("summary")
        assert body.get("next_action")
        assert isinstance(body.get("tags"), list)
    finally:
        db = SessionLocal()
        db.query(LeadIntake).filter(LeadIntake.id == iid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_enrich_unknown_type_and_404(api):
    assert api.post("/api/ai/enrich/widget/1", json={}).json().get("error")
    assert api.post("/api/ai/enrich/lead/999999", json={}).json().get("error")


def test_draft_conversation_reply_fallback(api):
    db = SessionLocal()
    c = Client(name="Convo Client", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    client_id = c.id
    conv = Conversation(client_id=client_id, channel="sms", status="open", org_id=1)
    db.add(conv); db.commit(); cid = conv.id
    db.close()
    try:
        r = api.post(f"/api/ai/draft-conversation-reply/{cid}", json={})
        assert r.status_code == 200, r.text
        assert r.json().get("message")
        assert r.json().get("subject") == ""  # sms channel
    finally:
        db = SessionLocal()
        db.query(Conversation).filter(Conversation.id == cid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
        db.commit(); db.close()
