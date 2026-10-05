"""Resend the set-password invite to a sub still stuck at "invited".

The invite link is single-use + 7 days, and an invited account has no password,
so a missed email used to mean the office had to hand-copy the link out of the
approve response. POST /api/auth/users/{id}/resend-invite is the one-tap
recovery. Only for an account that hasn't accepted yet; office-only.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import User
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 9801, 1, "admin", "active", True
    email = "resend-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


class _Cleaner:
    id, org_id, role, status, active = 9802, 1, "cleaner", "active", True
    email = "resend-crew@example.com"
    full_name = "A Sub"
    cleaner_id = "CT-RS"


def _api(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    ids = []
    yield ids
    db = SessionLocal()
    db.query(User).filter(User.id.in_(ids or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk(status="invited"):
    db = SessionLocal()
    u = User(email=f"invitee-{uuid.uuid4().hex[:8]}@example.com", role="cleaner",
             full_name="Fresh Face", status=status, org_id=1, cleaner_id=f"bbx{uuid.uuid4().hex[:4]}")
    db.add(u); db.commit(); db.refresh(u)
    uid = u.id
    db.close()
    return uid


def test_resends_to_an_invited_account(made):
    uid = _mk("invited"); made.append(uid)
    r = _api(_Admin()).post(f"/api/auth/users/{uid}/resend-invite")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert "@" in body["email"]
    # Email is unconfigured in tests, so the contract hands back the live link
    # to copy (invite_sent False). Either way the field is present.
    assert "invite_sent" in body


def test_a_manager_can_resend_too(made):
    uid = _mk("invited"); made.append(uid)

    class _Manager:
        id, org_id, role, status, active = 9803, 1, "manager", "active", True
        email = "resend-mgr@example.com"; full_name = "Mgr"; cleaner_id = None

    r = _api(_Manager()).post(f"/api/auth/users/{uid}/resend-invite")
    assert r.status_code == 200, r.text


def test_refuses_once_they_have_set_a_password(made):
    uid = _mk("active"); made.append(uid)
    r = _api(_Admin()).post(f"/api/auth/users/{uid}/resend-invite")
    assert r.status_code == 409
    assert "already" in r.json()["detail"].lower()


def test_unknown_user_is_404(made):
    r = _api(_Admin()).post("/api/auth/users/987654/resend-invite")
    assert r.status_code == 404


def test_a_cleaner_cannot_resend_invites(made):
    uid = _mk("invited"); made.append(uid)
    r = _api(_Cleaner()).post(f"/api/auth/users/{uid}/resend-invite")
    assert r.status_code == 403
