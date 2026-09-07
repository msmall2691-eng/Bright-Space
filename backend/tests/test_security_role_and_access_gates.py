"""Who may read what — the gaps a security audit turned up, closed.

Five endpoints and one public-prefix stem. Every case here FAILED against the
code as it shipped; each is a thing an approved bench subcontractor, or in one
case an unauthenticated stranger, could actually do.

THE WORST ONE first, because the file it lives in already forbade it.
`modules/ai/router.py` says at the top of its fact-gatherer: "property blocks
NEVER include access details (house codes, lockbox locations in access_notes,
wifi credentials) … they must not enter any AI prompt." Three hundred lines
later `_gather_enrich_facts` put `access_notes` and `parking_notes` in the dict
that `enrich_entity` json.dumps() straight into the user message. The rule was
written down and then broken in the same file, and the endpoint that did it
had no role gate — so any login could name any property id.

The rest are the same shape: reads whose sibling writes are guarded and which
lost the gate in a copy-paste. A cleaner has a login because the office
approved them onto the bench. That is admission, not clearance.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

import auth
from main import app
from database.db import SessionLocal
from database.models import Client, Property, User
from modules.auth.router import current_org_id, get_current_user


class _Cleaner:
    id, org_id, role, status, active = 9601, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "bench@example.com", "A Sub", "CT-SEC"


class _Admin:
    id, org_id, role, status, active = 9602, 1, "admin", "active", True
    email, full_name, cleaner_id = "office@example.com", "The Office", None


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": []}
    yield ids
    db = SessionLocal()
    db.query(Property).filter(
        Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(
        Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _api(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _mk_property(ids, *, org_id=1, access="Lockbox by the side door, code 4412"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Sec {tag}", status="active", org_id=org_id,
               email=f"sec-{tag}@example.com", phone="207-555-0100")
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"Sea View {tag}", address=f"9 Cliff {tag}",
                 city="Rockport", state="ME", org_id=org_id,
                 access_notes=access, parking_notes="Park behind the shed; key under mat")
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    out = (c.id, p.id)
    db.close()
    return out


# ── The crown jewels never enter an AI prompt ───────────────────────────────

def test_access_details_are_not_in_the_enrichment_facts(ids):
    """The fact dict IS the prompt — enrich_entity json.dumps() it verbatim
    into the user message. So this asserts on the dict rather than mocking
    Anthropic: if a door code is in here, it has already left the building."""
    from modules.ai.router import _gather_enrich_facts

    _cid, pid = _mk_property(ids)
    db = SessionLocal()
    try:
        facts, _title, _action = _gather_enrich_facts("property", pid, db, 1)
    finally:
        db.close()

    assert facts is not None, "the property should still resolve"
    blob = str(facts)
    assert "4412" not in blob and "Lockbox" not in blob
    assert "key under mat" not in blob
    assert "access_notes" not in facts and "parking_notes" not in facts
    # Still useful: the enrichment does not need a door code to describe a house.
    assert facts.get("name") and facts.get("address")


def test_enrichment_does_not_reach_across_orgs(ids):
    from modules.ai.router import _gather_enrich_facts

    _cid, theirs = _mk_property(ids, org_id=2)
    db = SessionLocal()
    try:
        facts, title, action = _gather_enrich_facts("property", theirs, db, 1)
    finally:
        db.close()
    # Wrong org and nonexistent are indistinguishable, on purpose.
    assert (facts, title, action) == (None, None, None)


def test_a_cleaner_cannot_ask_the_ai_about_a_property(ids):
    _cid, pid = _mk_property(ids)
    r = _api(_Cleaner()).post(f"/api/ai/enrich/property/{pid}")
    assert r.status_code == 403, r.text


# ── Reads whose sibling writes were already guarded ─────────────────────────

@pytest.mark.parametrize("path", [
    "/api/clients/{cid}/crm-summary",
    "/api/clients/{cid}/phones",
    "/api/clients/{cid}/profile",
])
def test_a_cleaner_cannot_read_a_customers_file(ids, path):
    cid, _pid = _mk_property(ids)
    r = _api(_Cleaner()).get(path.format(cid=cid))
    assert r.status_code == 403, f"{path} -> {r.status_code} {r.text[:200]}"


def test_a_cleaner_cannot_read_the_receivables_book(ids):
    r = _api(_Cleaner()).get("/api/ai/overdue-reminders")
    assert r.status_code == 403, r.text


def test_a_cleaner_cannot_read_guest_bookings(ids):
    _cid, pid = _mk_property(ids)
    r = _api(_Cleaner()).get(f"/api/properties/{pid}/ical-events")
    assert r.status_code == 403, r.text


def test_the_office_can_still_do_all_of_it(ids):
    """The gates must not have locked out the people who need these."""
    cid, pid = _mk_property(ids)
    api = _api(_Admin())
    for path in (f"/api/clients/{cid}/crm-summary",
                 f"/api/clients/{cid}/phones",
                 f"/api/clients/{cid}/profile",
                 f"/api/properties/{pid}/ical-events",
                 "/api/ai/overdue-reminders"):
        assert api.get(path).status_code == 200, path


def test_a_client_file_from_another_org_is_not_readable(ids):
    theirs, _pid = _mk_property(ids, org_id=2)
    api = _api(_Admin())          # org 1
    assert api.get(f"/api/clients/{theirs}/crm-summary").status_code == 404
    assert api.get(f"/api/clients/{theirs}/phones").status_code == 404


# ── The public prefix that opened a stem ────────────────────────────────────

def test_google_signin_is_public_and_the_account_endpoints_are_not():
    """`_is_public` is a PREFIX match, so the bare stem "/api/auth/google"
    also opened /api/auth/google-account — the signed-in user's Google
    connection endpoints — and past the middleware `get_current_user` hands a
    request with no Authorization header a synthetic role="admin" user."""
    for open_path in ("/api/auth/google",
                      "/api/auth/google/config",
                      "/api/auth/google/login-url",
                      "/api/auth/google/login-callback",
                      "/api/auth/google/exchange",
                      # An OAuth redirect: Google sends the browser here with
                      # no Bearer header and the handler resolves the user from
                      # a one-time state nonce. Gating it silently breaks
                      # connecting a Google account.
                      "/api/auth/google-account/callback"):
        assert auth._is_public(open_path) is True, open_path

    for shut_path in ("/api/auth/google-account",
                      "/api/auth/google-account/connect-url",
                      "/api/auth/googlexyz"):
        assert auth._is_public(shut_path) is False, shut_path
