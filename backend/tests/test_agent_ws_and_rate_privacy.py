"""Two doors that were fine while every login belonged to someone you hired.

The public apply form (#761) mints a `cleaner` login for anybody who fills in a
web form and sets a password. Approval is an account, not clearance. So both of
these stopped being internal-only the day it shipped:

  * **/ws/agent/{name} checked for a valid JWT and never for a ROLE.** Any
    authenticated login reached any agent, and the agents read the whole
    business — Finn returns the client list and the outstanding-invoice total,
    and `run_operation` in the shared tool set creates Job rows and sends real
    Google Calendar invites to customers.

  * **posted_rate and agreed_rate were serialized to the `cleaner` role** on
    all four job endpoints that allow it. Any sub could enumerate what every
    other sub had agreed, on every job, from the office's own API — their
    competitors' prices. The crew payloads are carefully stripped of door codes
    and the customer's identity; this was not stripped at all.

Neither fix takes anything from a sub that they need: they bid from
/api/crew/my-day, which builds its own rows and deliberately carries the asking
price of a job they may claim.
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from main import app
from auth_jwt import create_jwt
from database.db import SessionLocal
from database.models import Client, Job, Property, User
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today

client = TestClient(app)


class _Role:
    """An authenticated caller of a given role."""
    def __init__(self, role, uid=9950, cleaner_id=None):
        self.id, self.org_id, self.role = uid, 1, role
        self.status, self.active = "active", True
        self.email = f"{role}-{uid}@example.com"
        self.full_name = f"{role.title()} {uid}"
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": []}
    yield m
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_job(m, *, cleaner_ids=("CT-X",), posted=180.0, agreed=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Rates {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Rate Rd", city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Clean",
            scheduled_date=business_today(), status="scheduled",
            cleaner_ids=list(cleaner_ids), posted_rate=posted, agreed_rate=agreed)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


# ── the agent socket ────────────────────────────────────────────────────────

def _ws(role):
    """Open the agent socket with a REAL signed JWT for this role — the token
    is what the handler inspects, so a dependency override would prove
    nothing."""
    token = create_jwt(4242, f"{role}@example.com", role)
    return client.websocket_connect(f"/ws/agent/finn?token={token}")


def test_a_cleaner_login_cannot_open_an_agent():
    """This is the whole finding. A cleaner's token is valid — that was enough."""
    with pytest.raises(WebSocketDisconnect) as e:
        with _ws("cleaner"):
            pass
    assert e.value.code == 1008


def test_a_client_portal_login_cannot_either():
    for role in ("client", "portal", ""):
        with pytest.raises(WebSocketDisconnect):
            with _ws(role):
                pass


@pytest.mark.parametrize("role", ["admin", "manager", "viewer", "member"])
def test_the_office_is_unaffected(role):
    """The control. A role check that locked out the people who use the agents
    would be a worse bug than the one it fixes."""
    with _ws(role) as ws:
        # Connected. What it says next depends on ANTHROPIC_API_KEY being
        # configured, which is not what this test is about — reaching the
        # handler at all is.
        assert ws is not None


def test_an_invalid_token_is_still_refused():
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/agent/finn?token=not-a-jwt"):
            pass


# ── the rates ───────────────────────────────────────────────────────────────

def test_a_cleaner_never_sees_the_rates_on_the_office_job_endpoints(made):
    job = _mk_job(made, posted=180.0, agreed=205.0)
    api = _as(_Role("cleaner", uid=9951, cleaner_id="CT-X"))

    one = api.get(f"/api/jobs/{job}")
    assert one.status_code == 200
    assert "posted_rate" not in one.json()
    assert "agreed_rate" not in one.json()

    listed = api.get("/api/jobs")
    assert listed.status_code == 200
    rows = listed.json()
    rows = rows["items"] if isinstance(rows, dict) else rows
    mine = [r for r in rows if r["id"] == job]
    assert mine and "posted_rate" not in mine[0] and "agreed_rate" not in mine[0]

    details = api.get(f"/api/jobs/{job}/details")
    assert details.status_code == 200
    assert "posted_rate" not in details.json()
    assert "agreed_rate" not in details.json()

    today = business_today().isoformat()
    week = api.get(f"/api/schedule/week?scheduled_date_from={today}"
                   f"&scheduled_date_to={today}")
    assert week.status_code == 200
    for r in week.json().get("jobs", []):
        assert "posted_rate" not in r and "agreed_rate" not in r


@pytest.mark.parametrize("role", ["admin", "manager", "viewer"])
def test_the_office_still_sees_both_rates(role, made):
    """The control. Stripping for everyone would break the screen the office
    prices work on."""
    job = _mk_job(made, posted=180.0, agreed=205.0)
    body = _as(_Role(role, uid=9952)).get(f"/api/jobs/{job}").json()
    assert body["posted_rate"] == 180.0
    assert body["agreed_rate"] == 205.0


def test_stripping_leaves_the_rest_of_the_job_intact(made):
    """A sub still needs the job. This closes a side door, not the front one."""
    job = _mk_job(made, posted=180.0)
    body = _as(_Role("cleaner", uid=9953, cleaner_id="CT-X")).get(f"/api/jobs/{job}").json()
    assert body["id"] == job
    assert body["title"] == "Clean"
    assert body["scheduled_date"]
    assert "open_for_claims" in body
