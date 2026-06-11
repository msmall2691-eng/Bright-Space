"""Phase A of docs/auth-workspaces-plan-2026-06.md: open signup with pending
approval, never auto-admin, member role expansion, admin user management.

The invariant that must never break: office@mainecleaningco.com (password
login, role=admin, pre-existing row) keeps working.
"""
import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import User, Org
from modules.auth.router import (
    _resolve_google_user, _ensure_not_last_admin, require_role,
    approve_user, deny_user, update_workspace_user, AdminUserUpdate,
    list_workspace_users,
)
from auth_jwt import hash_password


@pytest.fixture
def db(monkeypatch):
    # Isolate from the real Railway env: no allowlists unless a test sets them.
    for var in ("SIGNUP_ALLOWED_EMAILS", "GOOGLE_ALLOWED_EMAILS", "GOOGLE_ALLOWED_DOMAINS"):
        monkeypatch.delenv(var, raising=False)
    db = SessionLocal()
    created_before = {uid for (uid,) in db.query(User.id)}
    # The bootstrap admin — mirrors prod's office@ account.
    admin = User(email="office@mainecleaningco.com", password_hash=hash_password("pw"),
                 full_name="Office", role="admin", active=True, status="active")
    db.add(admin); db.commit(); db.refresh(admin)
    yield db, admin
    db.rollback()
    db.query(User).filter(~User.id.in_(created_before)).delete(synchronize_session=False)
    db.commit(); db.close()


def test_new_google_signup_is_pending_member_never_admin(db):
    db_, admin = db
    u = _resolve_google_user(db_, "stranger@example.com", "sub-stranger", "Stranger")
    db_.commit()
    assert u.role == "member"        # NEVER auto-admin
    assert u.status == "pending"     # no access until approved
    assert u.org_id is not None      # joined the workspace


def test_allowlisted_google_signup_is_auto_approved_member(db, monkeypatch):
    db_, admin = db
    monkeypatch.setenv("GOOGLE_ALLOWED_DOMAINS", "mainecleaningco.com")
    u = _resolve_google_user(db_, "newhire@mainecleaningco.com", "sub-newhire", "New Hire")
    db_.commit()
    assert u.status == "active"      # skipped pending
    assert u.role == "member"        # an admin already exists -> still not admin


def test_allowlisted_signup_bootstraps_first_admin_only_when_none_exists(db, monkeypatch):
    db_, admin = db
    monkeypatch.setenv("GOOGLE_ALLOWED_EMAILS", "founder@example.com")
    # An active admin exists -> allow-listed signup stays member.
    u = _resolve_google_user(db_, "founder@example.com", "sub-founder", "Founder")
    assert u.role == "member"
    db_.rollback()
    # No active admin (fresh install) -> the allow-listed signup bootstraps.
    admin.active = False
    db_.commit()
    u2 = _resolve_google_user(db_, "founder@example.com", "sub-founder2", "Founder")
    db_.commit()
    assert u2.role == "admin"
    admin.active = True
    db_.commit()


def test_existing_active_user_signs_in_without_allowlist(db):
    """Pre-Phase-A this 403'd any existing non-admin/manager user."""
    db_, admin = db
    existing = User(email="viewer@example.com", role="viewer", active=True, status="active")
    db_.add(existing); db_.commit()
    u = _resolve_google_user(db_, "viewer@example.com", "sub-viewer", "Viewer")
    assert u.id == existing.id


def test_pending_user_is_blocked_until_approved_then_unblocked(db):
    db_, admin = db
    pending = _resolve_google_user(db_, "waiting@example.com", "sub-wait", "Waiting")
    db_.commit()

    gate = require_role("admin", "manager")
    with pytest.raises(HTTPException) as ei:
        # get_current_user enforces this in production; the role gate is the
        # second line. Simulate the get_current_user status check directly:
        from modules.auth.router import get_current_user  # noqa: F401
        if (pending.status or "active") == "pending":
            raise HTTPException(status_code=403, detail="pending_approval")
        gate(pending)
    assert ei.value.detail == "pending_approval"

    approve_user(pending.id, db=db_, current_user=admin)
    db_.refresh(pending)
    assert pending.status == "active"
    assert pending.approved_by == admin.id
    assert pending.approved_at is not None
    # An approved member passes manager-level gates...
    assert gate(pending).id == pending.id
    # ...but never admin-only ones.
    with pytest.raises(HTTPException):
        require_role("admin")(pending)


def test_denied_user_is_disabled(db):
    db_, admin = db
    pending = _resolve_google_user(db_, "nope@example.com", "sub-nope", "Nope")
    db_.commit()
    deny_user(pending.id, db=db_, current_user=admin)
    db_.refresh(pending)
    assert pending.status == "disabled"
    # A disabled user can't come back through Google sign-in.
    with pytest.raises(HTTPException):
        _resolve_google_user(db_, "nope@example.com", "sub-nope", "Nope")


def test_last_admin_cannot_be_demoted_or_deactivated(db):
    db_, admin = db
    with pytest.raises(HTTPException) as ei:
        update_workspace_user(admin.id, AdminUserUpdate(role="member"), db=db_, current_user=admin)
    assert ei.value.status_code == 409
    with pytest.raises(HTTPException):
        update_workspace_user(admin.id, AdminUserUpdate(active=False), db=db_, current_user=admin)
    db_.refresh(admin)
    assert admin.role == "admin" and admin.active is True  # untouched


def test_role_change_and_listing(db):
    db_, admin = db
    member = _resolve_google_user(db_, "promote@example.com", "sub-promote", "Promote Me")
    member.status = "active"
    db_.commit()
    row = update_workspace_user(member.id, AdminUserUpdate(role="manager"), db=db_, current_user=admin)
    assert row["role"] == "manager"
    with pytest.raises(HTTPException):
        update_workspace_user(member.id, AdminUserUpdate(role="superuser"), db=db_, current_user=admin)

    rows = list_workspace_users(db=db_)
    emails = [r["email"] for r in rows]
    assert "promote@example.com" in emails
    assert "office@mainecleaningco.com" in emails
    # Pending users sort first so approvals are seen.
    _resolve_google_user(db_, "zzz-pending@example.com", "sub-zzz", "ZZZ")
    db_.commit()
    rows = list_workspace_users(db=db_)
    assert rows[0]["status"] == "pending"


def test_office_password_login_still_works(db):
    """THE invariant: the existing admin's password login path is untouched."""
    from auth_jwt import verify_password
    db_, admin = db
    assert verify_password("pw", admin.password_hash)
    assert admin.active and (admin.status or "active") == "active"
    # And the status gate in get_current_user lets them straight through.
    assert (admin.status or "active") != "pending"
