"""MT-4: a brand-new self-signup founds its OWN workspace (org) and is its admin.

Joining an EXISTING workspace (allow-list / admin invite) still lands in the
primary org; only net-new strangers get a fresh, isolated org. The
bootstrap-first-admin decision is scoped to the primary org so a stranger's
self-founded admin org can't suppress it.
"""
import pytest

from database.db import SessionLocal
from database.models import User, Org
from modules.auth.router import (
    _resolve_google_user, _create_org_for_signup, _slugify, _default_org_id,
)
from auth_jwt import hash_password


@pytest.fixture
def db(monkeypatch):
    for var in ("SIGNUP_ALLOWED_EMAILS", "GOOGLE_ALLOWED_EMAILS", "GOOGLE_ALLOWED_DOMAINS"):
        monkeypatch.delenv(var, raising=False)
    db = SessionLocal()
    users_before = {uid for (uid,) in db.query(User.id)}
    orgs_before = {oid for (oid,) in db.query(Org.id)}
    admin = User(email="office@mainecleaningco.com", password_hash=hash_password("pw"),
                 full_name="Office", role="admin", active=True, status="active",
                 org_id=_default_org_id(db))
    db.add(admin); db.commit(); db.refresh(admin)
    yield db, admin
    db.rollback()
    db.query(User).filter(~User.id.in_(users_before)).delete(synchronize_session=False)
    db.query(Org).filter(~Org.id.in_(orgs_before)).delete(synchronize_session=False)
    db.commit(); db.close()


def test_slugify():
    assert _slugify("Acme Cleaning Co.") == "acme-cleaning-co"
    assert _slugify("   ") == "workspace"
    assert _slugify("!!!") == "workspace"
    assert len(_slugify("x" * 100)) <= 48


def test_create_org_dedupes_slug(db):
    db_, _ = db
    a = _create_org_for_signup(db_, "Acme")
    b = _create_org_for_signup(db_, "Acme")
    assert a.slug == "acme"
    assert b.slug == "acme-2"
    assert a.id != b.id


def test_two_strangers_get_separate_isolated_workspaces(db):
    db_, admin = db
    primary = _default_org_id(db_)
    a = _resolve_google_user(db_, "a@stranger.com", "sub-a", "Stranger A")
    b = _resolve_google_user(db_, "b@stranger.com", "sub-b", "Stranger B")
    db_.commit()
    assert a.org_id != primary and b.org_id != primary
    assert a.org_id != b.org_id              # each founds its OWN workspace
    assert a.role == "admin" and b.role == "admin"
    assert a.status == "active" and b.status == "active"


def test_allowlisted_signup_joins_primary_workspace(db, monkeypatch):
    db_, admin = db
    monkeypatch.setenv("GOOGLE_ALLOWED_DOMAINS", "mainecleaningco.com")
    primary = _default_org_id(db_)
    u = _resolve_google_user(db_, "newhire@mainecleaningco.com", "sub-nh", "New Hire")
    db_.commit()
    assert u.org_id == primary               # joins the existing workspace
    assert u.role == "member" and u.status == "active"


def test_admin_created_user_joins_creating_admins_org(db):
    """Tenant-correctness: an admin in org X who creates a user lands that user
    in org X — not always the primary org."""
    import uuid
    from fastapi.testclient import TestClient
    from main import app
    from modules.auth.router import get_current_user_optional

    db_, _ = db
    org_x = _create_org_for_signup(db_, "Org X")
    db_.commit()

    class _AdminInOrgX:
        id, role, org_id = 4242, "admin", org_x.id
        email, status, active = "adminx@example.com", "active", True

    app.dependency_overrides[get_current_user_optional] = lambda: _AdminInOrgX()
    try:
        email = f"hire-{uuid.uuid4().hex[:8]}@example.com"
        r = TestClient(app).post("/api/auth/register",
                                 json={"email": email, "password": "pw123456"})
        assert r.status_code == 200, r.text
        created = db_.query(User).filter(User.email == email).first()
        assert created is not None
        assert created.org_id == org_x.id          # joined the admin's org, not primary
        assert created.role == "client"
        db_.query(User).filter(User.id == created.id).delete(synchronize_session=False)
        db_.commit()
    finally:
        app.dependency_overrides.pop(get_current_user_optional, None)


def test_stranger_admin_does_not_block_primary_bootstrap(db, monkeypatch):
    """A stranger self-founding an admin org must NOT suppress the primary
    install's bootstrap-first-admin — the admin check is org-scoped."""
    db_, admin = db
    primary = _default_org_id(db_)
    admin.active = False                       # primary org now admin-less
    db_.commit()
    # A stranger signs up first -> founds their own admin org (not primary).
    s = _resolve_google_user(db_, "first@stranger.com", "sub-f", "First")
    db_.commit()
    assert s.role == "admin" and s.org_id != primary
    # An allow-listed founder then joins the PRIMARY org -> still bootstraps.
    monkeypatch.setenv("GOOGLE_ALLOWED_EMAILS", "founder@example.com")
    f = _resolve_google_user(db_, "founder@example.com", "sub-fo", "Founder")
    db_.commit()
    assert f.org_id == primary
    assert f.role == "admin"                   # bootstrapped despite stranger's admin org
    admin.active = True; db_.commit()
