"""Seeing what a cleaner sees, from the office.

The owner asked to preview a specific person's real screen — useful when
somebody reports "it's blank for me" and you need to know whether it is their
phone or their data.

WHAT MAKES IT SAFE IS NOT THIS ENDPOINT. Every mutating crew route
(/complete, /claim, /respond, /helpers) is Depends(require_role("cleaner")),
and require_role is a strict membership test with NO admin bypass. So an
office session cannot accept, decline, claim or complete anything as a
cleaner — the API refuses regardless of what any UI renders. Those tests are
here because that property is the whole basis for allowing the preview at all,
and if somebody ever adds an admin bypass to require_role, this file is where
it should stop them.

Why it matters more than "don't touch other people's stuff": an office user
tapping Accept for a subcontractor would be ASSIGNING them work. A sub
requests or accepts and is never assigned (brightbase-marketplace Rule 0),
which is worker classification, not etiquette.

The rest: office roles only, org-scoped, one 404 for wrong-org / wrong-role /
nonexistent so it cannot enumerate people, and the payload says whose day it
is so the screen can never be mistaken for your own.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import User
from modules.auth.router import current_org_id, get_current_user


class _Admin:
    id, org_id, role, status, active = 9701, 1, "admin", "active", True
    email, full_name, cleaner_id = "office@example.com", "The Office", None


class _Manager(_Admin):
    id, role, email = 9702, "manager", "manager@example.com"


class _OtherCleaner:
    id, org_id, role, status, active = 9703, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "nosy@example.com", "Nosy Sub", "CT-NOSY"


@pytest.fixture
def ids():
    ids = {"users": []}
    yield ids
    db = SessionLocal()
    db.query(User).filter(User.id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_cleaner(ids, *, org_id=1, role="cleaner", cleaner_id=None):
    db = SessionLocal()
    u = User(email=f"sub-{uuid.uuid4().hex[:6]}@example.com", role=role,
             full_name="Dana Reed", org_id=org_id, active=True, status="active",
             cleaner_id=cleaner_id if cleaner_id is not None else f"CT-{uuid.uuid4().hex[:6]}")
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id)
    uid = u.id; db.close()
    return uid


def _api(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


# ── The office can look ─────────────────────────────────────────────────────

def test_the_office_sees_the_cleaners_own_payload(ids):
    uid = _mk_cleaner(ids)
    r = _api(_Admin()).get(f"/api/crew/preview/{uid}/my-day")
    assert r.status_code == 200, r.text
    body = r.json()
    # The REAL my-day payload, not a lookalike. These are the keys the crew app
    # renders, and calling my_day() directly rather than rebuilding it is what
    # guarantees the preview cannot drift from the screen it claims to show.
    for key in ("as_of", "crew_id", "first_name", "open_jobs"):
        assert key in body, key
    assert body["crew_id"], "the payload is resolved for the TARGET, not the viewer"
    assert body["preview"] == {"read_only": True, "cleaner_name": "Dana Reed",
                               "user_id": uid}


def test_a_manager_can_look_too(ids):
    uid = _mk_cleaner(ids)
    assert _api(_Manager()).get(f"/api/crew/preview/{uid}/my-day").status_code == 200


# ── And cannot act ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("path,body", [
    ("/api/crew/jobs/1/complete", {}),
    ("/api/crew/jobs/1/claim", {}),
    ("/api/crew/jobs/1/respond", {"response": "accepted"}),
    ("/api/crew/jobs/1/helpers", {"name": "A Friend"}),
])
def test_an_office_session_cannot_act_as_a_cleaner(ids, path, body):
    """THE property the preview rests on.

    Accepting a job for a subcontractor would be assigning them work, which is
    the one thing this arrangement cannot do. It is refused by the API, so no
    UI mistake can produce it.
    """
    r = _api(_Admin()).post(path, json=body)
    assert r.status_code == 403, f"{path} -> {r.status_code} {r.text[:160]}"


def test_require_role_has_no_admin_bypass():
    """Pinned directly, because the parametrised cases above would all still
    pass for the wrong reason if somebody made admin satisfy every role — the
    403s would become 404s on a missing job and look fine at a glance."""
    from modules.auth.router import require_role

    check = require_role("cleaner")
    admin = _Admin()
    with pytest.raises(Exception) as e:
        check(current_user=admin)
    assert getattr(e.value, "status_code", None) == 403


# ── Who may look, and at whom ───────────────────────────────────────────────

def test_a_cleaner_cannot_preview_another_cleaner(ids):
    uid = _mk_cleaner(ids)
    r = _api(_OtherCleaner()).get(f"/api/crew/preview/{uid}/my-day")
    assert r.status_code == 403, r.text


def test_another_orgs_cleaner_is_not_previewable(ids):
    theirs = _mk_cleaner(ids, org_id=2)
    r = _api(_Admin()).get(f"/api/crew/preview/{theirs}/my-day")
    assert r.status_code == 404, r.text


def test_a_non_cleaner_account_is_not_previewable(ids):
    """The office previewing another office account is not what this is for,
    and answering differently would say which ids are staff."""
    staff = _mk_cleaner(ids, role="manager")
    assert _api(_Admin()).get(f"/api/crew/preview/{staff}/my-day").status_code == 404


def test_wrong_org_wrong_role_and_missing_are_one_answer(ids):
    theirs = _mk_cleaner(ids, org_id=2)
    staff = _mk_cleaner(ids, role="admin")
    api = _api(_Admin())
    codes = {api.get(f"/api/crew/preview/{x}/my-day").status_code
             for x in (theirs, staff, 99999999)}
    assert codes == {404}, f"distinguishable: {codes}"
