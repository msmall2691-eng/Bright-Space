"""Applying to join the bench (marketplace pivot Phase 8, migration 102).

Last on purpose: an apply form is worthless until there's a file for an
accepted sub to fill in (098), a way to pay them (099), and work to offer them
(100, 101).

This endpoint is the only PUBLIC write the pivot adds, so most of what's
pinned here is what it refuses to do:

  * it creates a row and nothing else — no login, ever;
  * it will not say whether an email is already known. An endpoint that
    answered that differently would be an account-enumeration oracle wearing a
    form;
  * a second application from the same person inside a day updates the first
    rather than stacking rows;
  * but it will NOT overwrite a decided one — reapplying must not quietly undo
    a decline;
  * oversized fields are capped before they reach the database;
  * the honeypot looks accepted and stores nothing.

Plus the boundary itself: /api/apply is public EXACTLY, and its neighbours are
not. Listing it as a prefix would have opened anything sharing the stem.

And the approval path: admin-only, mints exactly one crew account, and does NOT
clear anybody to work — an approved application is an invitation to get vetted,
not a shortcut past it.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import SubApplication, User
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 9901, 1, "admin", "active", True
    email = "apply-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


class _Manager:
    id, org_id, role, status, active = 9902, 1, "manager", "active", True
    email = "apply-manager@example.com"
    full_name = "A Manager"
    cleaner_id = None


class _Cleaner:
    id, org_id, role, status, active = 9903, 1, "cleaner", "active", True
    email = "apply-crew@example.com"
    full_name = "A Sub"
    cleaner_id = "CT-APPLY"


def _api(user=None):
    if user is not None:
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    """Reset the per-IP limiter between tests.

    The limit (10/hour) is real and worth having — this is the one public write
    the pivot adds. But every test here shares one client IP, so without this
    the eleventh request in the whole FILE gets a 429 and the rest of the suite
    tests the limiter instead of the endpoint.

    Resetting rather than raising the cap keeps the production number honest:
    there is a test below that deliberately exhausts it, and it would be
    meaningless against a limit loosened for the test run.
    """
    from ratelimit import limiter
    try:
        limiter.reset()
    except Exception:
        # Older slowapi has no reset(); clear the underlying storage instead.
        storage = getattr(limiter, "_storage", None) or getattr(
            getattr(limiter, "limiter", None), "storage", None)
        if storage is not None and hasattr(storage, "storage"):
            storage.storage.clear()
    yield


@pytest.fixture
def made():
    m = {"emails": [], "users": []}
    yield m
    db = SessionLocal()
    db.query(SubApplication).filter(SubApplication.email.in_(m["emails"] or [""])).delete(
        synchronize_session=False)
    db.query(User).filter(User.email.in_(m["emails"] or [""])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _email(m):
    e = f"applicant-{uuid.uuid4().hex[:8]}@example.com"
    m["emails"].append(e)
    return e


def _apply(body):
    # No auth override — this must work with no session at all.
    return TestClient(app).post("/api/apply", json=body)


def _rows(email):
    db = SessionLocal()
    out = db.query(SubApplication).filter(SubApplication.email == email).all()
    data = [{"id": r.id, "name": r.name, "status": r.status, "phone": r.phone,
             "experience": r.experience, "user_id": r.user_id,
             "towns": r.towns} for r in out]
    db.close()
    return data


# ── The public boundary ─────────────────────────────────────────────────────

def test_apply_is_public_exactly_and_its_neighbours_are_not():
    """A prefix entry would have opened anything sharing the stem — a later
    /api/apply-status or /api/applications would go public silently, with no
    test failing."""
    from auth import _is_public

    assert _is_public("/api/apply")
    assert _is_public("/api/apply/")
    for neighbour in ("/api/apply-status", "/api/applications", "/api/apply/secret",
                      "/api/sub-applications", "/api/sub-applications/1/approve"):
        assert not _is_public(neighbour), f"{neighbour} must stay gated"


def test_the_office_endpoints_need_a_login(made):
    """The form is open; the pile of applications is not."""
    anon = TestClient(app)
    # tests/conftest.py auto-injects the shared BRIGHTBASE_API_KEY on every
    # request, which would make this client a synthetic ADMIN and the assertion
    # below pass for the wrong reason. It uses setdefault, so an explicit empty
    # header defeats it — this client really is anonymous.
    no_key = {"x-api-key": ""}
    for method, path in (("get", "/api/sub-applications"),
                         ("patch", "/api/sub-applications/1"),
                         ("post", "/api/sub-applications/1/approve")):
        kwargs = {"headers": no_key}
        if method != "get":
            kwargs["json"] = {}
        r = getattr(anon, method)(path, **kwargs)
        assert r.status_code in (401, 403), f"{path} answered {r.status_code}"

    # And the control: the same client CAN reach the public form, so the
    # refusals above are about authorization and not a broken client.
    assert anon.post("/api/apply", headers=no_key,
                     json={"name": "Anon", "email": f"anon-{uuid.uuid4().hex[:8]}@example.com"}
                     ).status_code == 201


# ── Applying ────────────────────────────────────────────────────────────────

def test_an_application_is_recorded_and_creates_no_account(made):
    email = _email(made)
    r = _apply({"name": "Dana Applicant", "email": email, "phone": "207-555-0111",
                "towns": "Scarborough, Saco", "experience": "6 years",
                "has_insurance": True, "weekends": True})
    assert r.status_code == 201, r.text
    assert r.json()["ok"] is True

    rows = _rows(email)
    assert len(rows) == 1
    assert rows[0]["status"] == "new"
    assert rows[0]["name"] == "Dana Applicant"
    assert rows[0]["user_id"] is None

    db = SessionLocal()
    assert db.query(User).filter(User.email == email).first() is None, \
        "applying must never create a login"
    db.close()


def test_the_answer_is_the_same_whether_or_not_we_know_the_email(made):
    """Anything else is an account-enumeration oracle wearing a form."""
    email = _email(made)
    first = _apply({"name": "Dana", "email": email})
    second = _apply({"name": "Dana", "email": email})
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()


def test_applying_twice_in_a_day_updates_rather_than_stacking(made):
    """Somebody who fills the form in twice is not two applicants."""
    email = _email(made)
    _apply({"name": "Dana", "email": email, "towns": "Saco"})
    _apply({"name": "Dana Applicant", "email": email, "towns": "Saco, Biddeford"})

    rows = _rows(email)
    assert len(rows) == 1
    assert rows[0]["name"] == "Dana Applicant"
    assert rows[0]["towns"] == "Saco, Biddeford"


def test_reapplying_does_not_overwrite_a_decision(made):
    """A decided application is somebody's answer. A fresh form must not
    quietly turn a decline back into a new lead."""
    email = _email(made)
    _apply({"name": "Dana", "email": email})
    api = _api(_Admin())
    try:
        app_id = _rows(email)[0]["id"]
        assert api.patch(f"/api/sub-applications/{app_id}",
                         json={"status": "declined"}).status_code == 200
    finally:
        _clear()

    _apply({"name": "Dana Again", "email": email})
    rows = sorted(_rows(email), key=lambda r: r["id"])
    assert len(rows) == 2, "a new application, not an edit of the declined one"
    assert rows[0]["status"] == "declined"
    assert rows[1]["status"] == "new"


def test_the_honeypot_looks_accepted_and_stores_nothing(made):
    """Telling a scraper it was caught only teaches it."""
    email = _email(made)
    r = _apply({"name": "Bot", "email": email, "website": "http://spam.example"})
    assert r.status_code == 201
    assert r.json()["ok"] is True
    assert _rows(email) == []


def test_oversized_fields_are_capped_before_they_reach_the_database(made):
    """A field can't be used as storage."""
    email = _email(made)
    r = _apply({"name": "Dana", "email": email, "experience": "x" * 50_000})
    assert r.status_code == 201
    assert len(_rows(email)[0]["experience"]) == 4000


def test_a_nameless_or_emailless_application_is_refused(made):
    assert _apply({"email": _email(made)}).status_code == 422
    assert _apply({"name": "Dana"}).status_code == 422
    assert _apply({"name": "Dana", "email": "not-an-email"}).status_code == 422


def test_no_field_anywhere_invites_a_social_security_number():
    """The handoff is explicit: never a raw SSN field. `ein` identifies a
    business, and it is the only identifier that gets a column."""
    from database.models import SubApplication as Model
    from modules.apply.router import ApplyBody

    columns = set(Model.__table__.columns.keys())
    accepted = set(ApplyBody.model_fields)
    for banned in ("ssn", "tin", "social_security", "tax_id", "taxpayer_id"):
        assert not any(banned in c for c in columns), f"column matching {banned}"
        assert not any(banned in f for f in accepted), f"form field matching {banned}"
    assert "ein" in columns and "ein" in accepted


# ── The office side ─────────────────────────────────────────────────────────

def test_the_list_carries_its_counts_so_one_request_draws_the_screen(made):
    email = _email(made)
    _apply({"name": "Dana", "email": email})
    api = _api(_Manager())
    try:
        body = api.get("/api/sub-applications").json()
        assert body["counts"]["new"] >= 1
        assert any(a["email"] == email for a in body["applications"])
        filtered = api.get("/api/sub-applications?status=declined").json()
        assert all(a["status"] == "declined" for a in filtered["applications"])
        # Counts describe everything, not just the filtered slice.
        assert filtered["counts"]["new"] >= 1
    finally:
        _clear()


def test_approved_cannot_be_set_by_hand(made):
    """That status is a side effect of creating the account. Setting it
    directly would leave applications marked approved with nobody to show."""
    email = _email(made)
    _apply({"name": "Dana", "email": email})
    api = _api(_Admin())
    try:
        app_id = _rows(email)[0]["id"]
        r = api.patch(f"/api/sub-applications/{app_id}", json={"status": "approved"})
        assert r.status_code == 422
        assert "Use Approve" in r.json()["detail"]
        assert _rows(email)[0]["status"] == "new"
    finally:
        _clear()


def test_approving_mints_one_crew_account_that_cannot_yet_work(made):
    """An approved application is an invitation to get vetted, not a shortcut
    past it — `can_take_jobs` stays false until the documents are on file."""
    from services.sub_vetting import can_take_jobs

    email = _email(made)
    _apply({"name": "Dana Applicant", "email": email})
    api = _api(_Admin())
    try:
        app_id = _rows(email)[0]["id"]
        r = api.post(f"/api/sub-applications/{app_id}/approve")
        assert r.status_code == 200, r.text
        assert r.json()["created_account"] is True
        assert r.json()["status"] == "approved"
    finally:
        _clear()

    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    assert user is not None
    made["users"].append(user.id)
    assert user.role == "cleaner"
    assert user.status == "invited"
    assert user.cleaner_id == f"bb{user.id}"
    assert user.password_hash is None, "they set their own from the invite"
    assert can_take_jobs(db, user.id) is False, "approval is not clearance"
    db.close()

    assert _rows(email)[0]["user_id"] == user.id


def test_approving_twice_does_not_mint_a_second_login(made):
    email = _email(made)
    _apply({"name": "Dana", "email": email})
    api = _api(_Admin())
    try:
        app_id = _rows(email)[0]["id"]
        api.post(f"/api/sub-applications/{app_id}/approve")
        again = api.post(f"/api/sub-applications/{app_id}/approve")
        assert again.status_code == 409
    finally:
        _clear()

    db = SessionLocal()
    users = db.query(User).filter(User.email == email).all()
    for u in users:
        made["users"].append(u.id)
    db.close()
    assert len(users) == 1


def test_an_applicant_who_already_works_here_is_linked_not_duplicated(made):
    email = _email(made)
    db = SessionLocal()
    existing = User(email=email, role="cleaner", full_name="Already Here",
                    org_id=1, active=True, status="active", cleaner_id="CT-HERE")
    db.add(existing); db.commit(); db.refresh(existing)
    made["users"].append(existing.id)
    existing_id = existing.id
    db.close()

    _apply({"name": "Already Here", "email": email})
    api = _api(_Admin())
    try:
        app_id = _rows(email)[0]["id"]
        r = api.post(f"/api/sub-applications/{app_id}/approve").json()
        assert r["created_account"] is False
        assert r["user_id"] == existing_id
    finally:
        _clear()

    db = SessionLocal()
    assert db.query(User).filter(User.email == email).count() == 1
    db.close()


def test_only_an_admin_approves(made):
    """A manager can read and triage; minting a login is admin-only."""
    email = _email(made)
    _apply({"name": "Dana", "email": email})
    api = _api(_Manager())
    try:
        app_id = _rows(email)[0]["id"]
        assert api.patch(f"/api/sub-applications/{app_id}",
                         json={"notes": "worth a call"}).status_code == 200
        assert api.post(f"/api/sub-applications/{app_id}/approve").status_code == 403
    finally:
        _clear()


def test_a_cleaner_cannot_read_the_applications(made):
    api = _api(_Cleaner())
    try:
        assert api.get("/api/sub-applications").status_code == 403
    finally:
        _clear()


# ── Tenancy ─────────────────────────────────────────────────────────────────

def test_sub_applications_is_rls_protected():
    from database.rls import TENANT_TABLES
    assert "sub_applications" in TENANT_TABLES


def test_another_orgs_application_is_not_visible_or_reachable(made):
    db = SessionLocal()
    email = _email(made)
    row = SubApplication(org_id=2, name="Theirs", email=email, status="new")
    db.add(row); db.commit(); db.refresh(row)
    other_id = row.id
    db.close()
    api = _api(_Admin())          # org 1
    try:
        listed = api.get("/api/sub-applications").json()["applications"]
        assert other_id not in [a["id"] for a in listed]
        assert api.patch(f"/api/sub-applications/{other_id}",
                         json={"notes": "x"}).status_code == 404
        assert api.post(f"/api/sub-applications/{other_id}/approve").status_code == 404
    finally:
        _clear()


def test_the_public_form_is_rate_limited(made):
    """The one public write the pivot adds. Ten an hour per IP is plenty for a
    person and not much use to a script."""
    seen = set()
    for _ in range(14):
        seen.add(_apply({"name": "Flood", "email": _email(made)}).status_code)
        if 429 in seen:
            break
    assert 429 in seen, "the public apply form must be rate limited"
