"""Native crew setup (Connecteam-free): add a cleaner → invite → accept, plus
the unclaimed-crew-IDs safety net that keeps scheduled jobs assigned across the
Connecteam cutover.

Same override pattern as test_dashboard_owner: stub get_current_user to an admin
and current_org_id to 1, then drive the real endpoints over HTTP.
"""
import uuid
from datetime import date, timedelta, time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import User, Client, Property, Job
from modules.auth.router import get_current_user, current_org_id
from auth_jwt import make_invite_token


class _Admin:
    id, org_id, role, status, active = 8801, 1, "admin", "active", True
    email = "crew-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    client = TestClient(app)
    made = {"users": [], "clients": [], "properties": [], "jobs": []}
    yield client, made
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _email():
    return f"cleaner-{uuid.uuid4().hex[:8]}@example.com"


def test_add_crew_creates_invited_passwordless_cleaner(api):
    client, made = api
    email = _email()
    r = client.post("/api/crew", json={"full_name": "Sam Clean", "email": email,
                                       "cleaner_id": "CT-77", "pay_rate_residential": 22.5})
    assert r.status_code == 200, r.text
    row = r.json()
    made["users"].append(row["id"])
    assert row["email"] == email
    assert row["cleaner_id"] == "CT-77"
    assert row["status"] == "invited"
    assert row["activated"] is False        # no password yet → invite not accepted
    assert row["pay_rate_residential"] == 22.5

    db = SessionLocal()
    u = db.query(User).filter(User.id == row["id"]).first()
    assert u.role == "cleaner" and u.password_hash is None
    db.close()


def test_add_crew_rejects_duplicate_email_and_negative_rate(api):
    client, made = api
    email = _email()
    r1 = client.post("/api/crew", json={"full_name": "A", "email": email})
    made["users"].append(r1.json()["id"])
    assert client.post("/api/crew", json={"full_name": "B", "email": email}).status_code == 409
    assert client.post("/api/crew", json={"full_name": "C", "email": _email(),
                                          "pay_rate_deep": -5}).status_code == 422


def test_accept_invite_sets_password_signs_in_and_is_single_use(api):
    client, made = api
    email = _email()
    r = client.post("/api/crew", json={"full_name": "Pat", "email": email})
    made["users"].append(r.json()["id"])

    token = make_invite_token(email)
    a = client.post("/api/auth/accept-invite", json={"token": token, "password": "s3cretpw!"})
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["access_token"] and body["email"] == email and body["role"] == "cleaner"

    # Replaying the (still-valid) link after a password exists is rejected — it's
    # a one-time invite, never a password-reset backdoor.
    a2 = client.post("/api/auth/accept-invite", json={"token": token, "password": "another8!"})
    assert a2.status_code == 409


def test_accept_invite_rejects_bad_token_and_short_password(api):
    client, made = api
    assert client.post("/api/auth/accept-invite",
                       json={"token": "garbage", "password": "longenough1"}).status_code == 400
    email = _email()
    r = client.post("/api/crew", json={"full_name": "Q", "email": email})
    made["users"].append(r.json()["id"])
    token = make_invite_token(email)
    assert client.post("/api/auth/accept-invite",
                       json={"token": token, "password": "short"}).status_code == 422


def test_unclaimed_ids_surfaces_unmapped_job_crew_then_clears_on_claim(api):
    client, made = api
    db = SessionLocal()
    c = Client(name="Crew Test", status="active", org_id=1); db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    made["clients"].append(c.id); made["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, title="J", job_type="residential",
            status="scheduled", scheduled_date=date.today() + timedelta(days=2),
            start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=["CT-UNMAPPED-1"], org_id=1)
    db.add(j); db.commit(); db.refresh(j); made["jobs"].append(j.id)
    db.close()

    ids = {row["cleaner_id"]: row["upcoming_jobs"] for row in client.get("/api/crew/unclaimed-ids").json()}
    assert ids.get("CT-UNMAPPED-1", 0) >= 1

    # Claiming that ID (a cleaner created with it) drops it off the unclaimed list.
    cr = client.post("/api/crew", json={"full_name": "Claimer", "email": _email(),
                                        "cleaner_id": "CT-UNMAPPED-1"})
    made["users"].append(cr.json()["id"])
    remaining = {row["cleaner_id"] for row in client.get("/api/crew/unclaimed-ids").json()}
    assert "CT-UNMAPPED-1" not in remaining


def test_roster_lists_cleaners(api):
    client, made = api
    r = client.post("/api/crew", json={"full_name": "Roster Person", "email": _email()})
    made["users"].append(r.json()["id"])
    roster = client.get("/api/crew/roster")
    assert roster.status_code == 200
    assert any(row["id"] == made["users"][0] for row in roster.json())


def test_resend_invite_before_and_after_activation(api):
    client, made = api
    email = _email()
    r = client.post("/api/crew", json={"full_name": "Re Send", "email": email})
    uid = r.json()["id"]; made["users"].append(uid)

    # Un-activated cleaner: the office can re-send the set-password link.
    assert client.post(f"/api/crew/{uid}/resend-invite").status_code == 200
    # Unknown id: 404, not a silent success.
    assert client.post("/api/crew/99999999/resend-invite").status_code == 404

    # Once they've accepted (password set) there's nothing to invite — 409, so
    # resend can never double as a password-reset backdoor.
    token = make_invite_token(email)
    assert client.post("/api/auth/accept-invite",
                       json={"token": token, "password": "s3cretpw!"}).status_code == 200
    assert client.post(f"/api/crew/{uid}/resend-invite").status_code == 409


def test_deactivate_cleaner_syncs_status_to_disabled(api):
    """Deactivating from the Users/Crew admin PATCH must move `status` in lockstep
    with `active` — otherwise the row shows an 'Active' pill beside a 'Re-enable'
    button for an account that can no longer log in."""
    client, made = api
    r = client.post("/api/crew", json={"full_name": "Deact", "email": _email()})
    uid = r.json()["id"]; made["users"].append(uid)

    d = client.patch(f"/api/auth/users/{uid}", json={"active": False})
    assert d.status_code == 200, d.text
    body = d.json()
    assert body["active"] is False
    assert body["status"] == "disabled"     # the badge field, now consistent

    # Re-enabling restores both in one step.
    e = client.patch(f"/api/auth/users/{uid}", json={"active": True})
    assert e.status_code == 200, e.text
    assert e.json()["active"] is True
    assert e.json()["status"] == "active"
