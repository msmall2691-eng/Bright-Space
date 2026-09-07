"""An open offer must not name the house — including through its TITLE.

`/api/crew/my-day` already blanked the fields an offer has no business
carrying: `address`, `property_name`, `client_name`, access notes, WiFi. The
reasoning is in the router and it is the right reasoning — whose house it is
stops being a bidder's business until they have actually won the job, because
the customer agreed to a cleaning company in their home, not to their name and
street address circulating among whoever is currently on the bench.

It missed the one field that is actually DISPLAYED. `integrations/ical_sync.py`
titles a generated turnover `f"Turnover — {prop.name}"`, and a Property's
`name` is its address — the model says so in its own comment ("4 Red Barn
Circle" (address, not service description)). So every rental turnover on the
open board was captioned with the customer's street address while the fields
beside it were carefully nulled. It was visible in a screenshot of the live
board: "Turnover — 22 Kincaid St".

An offer is titled from the two things it may say: the kind of work, and the
town.
"""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, SubDocument, User
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today

CREW = "CT-OFFER-T"


class _Sub:
    id, org_id, role, status, active = 9961, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "sub-offer-title@example.com", "Ada Nunez", CREW


def _as(user=_Sub()):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleared(monkeypatch):
    """This file is about what an offer SAYS, not who may see one. Clearing
    the vetting gate keeps it from silently passing on an empty board — which
    is exactly how it failed the first time it was run."""
    # Patched at the SOURCE module: the router imports it inside the request
    # function, so a name bound on the router is never consulted.
    import services.sub_vetting as vetting
    monkeypatch.setattr(vetting, "blocking_requirements", lambda db, user: [])
    yield


@pytest.fixture
def made():
    db = SessionLocal()
    if not db.query(User).filter(User.id == _Sub.id).first():
        db.add(User(id=_Sub.id, org_id=1, email=_Sub.email, full_name=_Sub.full_name,
                    role="cleaner", status="active", active=True, cleaner_id=CREW))
        db.commit()
    db.close()
    m = {"clients": [], "properties": [], "jobs": []}
    yield m
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id == _Sub.id).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _open_turnover(m, *, title):
    """A posted turnover titled the way ical_sync titles one."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Offer {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name="22 Kincaid St",
                 address="22 Kincaid St", city="Camden", state="ME",
                 property_type="str", house_code="4521",
                 access_notes="Side door lockbox")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, job_type="str_turnover",
            title=title, scheduled_date=business_today() + timedelta(days=2),
            start_time=time(10, 0), end_time=time(16, 0), status="scheduled",
            cleaner_ids=[], open_for_claims=True, posted_rate=140.0)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    db.close()


def _offers(monkeypatch=None):
    r = _as().get("/api/crew/my-day")
    assert r.status_code == 200, r.text
    return r.json()["open_jobs"]


def test_the_title_does_not_carry_the_address(made):
    _open_turnover(made, title="Turnover — 22 Kincaid St")
    offers = _offers()
    assert offers, "the posted job never reached the board"
    row = offers[0]
    assert "Kincaid" not in row["title"], row["title"]
    # What it may say instead: the work and the town.
    assert row["title"] == "Turnover — Camden ME"


def test_nothing_anywhere_in_the_offer_names_the_house(made):
    """Belt and braces across the whole row, not just the field that broke.
    A new field added later that carries the address should fail here."""
    _open_turnover(made, title="Turnover — 22 Kincaid St")
    blob = repr(_offers()[0])
    for leaked in ("Kincaid", "4521", "lockbox", "Side door"):
        assert leaked not in blob, f"{leaked!r} reached the open board"


def test_an_offer_with_no_town_on_file_still_has_a_name(made):
    """Falling back to the job's own title here would put the address back."""
    _open_turnover(made, title="Turnover — 22 Kincaid St")
    db = SessionLocal()
    db.query(Property).filter(Property.id.in_(made["properties"])).update(
        {"city": None, "state": None})
    db.commit(); db.close()
    assert _offers()[0]["title"] == "Turnover"


def test_an_assigned_job_keeps_its_real_title_and_address(made):
    """The stripping is for OFFERS. Once the job is yours you get the house —
    that is the whole point of winning it."""
    _open_turnover(made, title="Turnover — 22 Kincaid St")
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(made["jobs"])).update(
        {"cleaner_ids": [CREW], "open_for_claims": False})
    db.commit(); db.close()
    r = _as().get("/api/crew/my-day")
    rows = r.json()["upcoming"] + r.json()["today"]
    mine = [j for j in rows if j["id"] in made["jobs"]]
    assert mine, "the assigned job vanished"
    assert "Kincaid" in repr(mine[0]), "an assigned job lost the house it needs"
