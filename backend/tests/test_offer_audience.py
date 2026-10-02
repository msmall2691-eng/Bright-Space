"""Targeted offers (migration 117): the office can limit which cleaners see an
open job — without it becoming an assignment.

What must hold (brightbase-marketplace Rule 0 — offered, never assigned):
- An offer with an audience is shown ONLY to the listed cleaners on their board;
  everyone else's board doesn't carry it.
- An empty/absent audience is shown to every cleared sub (the default).
- Targeting is VISIBILITY ONLY: a targeted sub sees an offer to *ask* for, not
  an assignment — cleaner_ids is untouched and they still have to claim.
- PATCH /api/jobs/{id} validates the audience against real cleaner accounts (a
  non-empty audience matching nobody is a 400, not a job hidden from all), and
  the office job dict serializes the audience so the board can edit it.
"""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, JobClaimRequest, SubAgreement, SubDocument, User
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9950, 1, "admin", "active", True
    email = "admin@example.com"
    full_name = "The Office"
    cleaner_id = None


def _vet(uid, org_id=1):
    """A complete vetting file so the sub is cleared to see the board."""
    from services.sub_vetting import CURRENT_AGREEMENT_VERSION
    db = SessionLocal()
    db.query(SubDocument).filter(SubDocument.user_id == uid).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id == uid).delete(synchronize_session=False)
    db.add(SubAgreement(org_id=org_id, user_id=uid, version=CURRENT_AGREEMENT_VERSION,
                        accepted_at=business_today()))
    db.add(SubDocument(org_id=org_id, user_id=uid, kind="w9", status="accepted", data=b"x"))
    db.add(SubDocument(org_id=org_id, user_id=uid, kind="coi", status="accepted", data=b"x",
                       expires_at=business_today() + timedelta(days=365)))
    db.commit(); db.close()


def _as(user):
    if getattr(user, "role", None) == "cleaner":
        _vet(user.id)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


# Real cleaner rows so audience validation (which checks known cleaner_ids)
# recognizes them.
A_UID, A_CID = 9971, "CT-oa-A"
B_UID, B_CID = 9972, "CT-oa-B"


@pytest.fixture
def world():
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    db.merge(User(id=A_UID, email=f"a-{tag}@x.com", full_name="Ada", role="cleaner",
                  cleaner_id=A_CID, org_id=1, password_hash="x"))
    db.merge(User(id=B_UID, email=f"b-{tag}@x.com", full_name="Ben", role="cleaner",
                  cleaner_id=B_CID, org_id=1, password_hash="x"))
    db.commit(); db.close()
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    _clear()
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id.in_([A_UID, B_UID])).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id.in_([A_UID, B_UID])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_([A_UID, B_UID])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_open_job(ids, *, offer_audience=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"OA {tag}", status="active", org_id=1, phone="207-555-0100")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"3 Oak {tag}", address=f"3 Oak {tag}", org_id=1,
                 city="Portland", state="ME", house_code="1234", access_notes="Side door")
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=f"Clean {tag}",
            scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=[], status="scheduled", org_id=1,
            open_for_claims=True, posted_rate=80.0, offer_audience=offer_audience)
    db.add(j); db.commit(); db.refresh(j)
    ids["clients"].append(c.id); ids["properties"].append(p.id); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _open_ids(cleaner):
    day = _as(cleaner).get("/api/crew/my-day").json()
    _clear()
    return {j["id"] for j in day["open_jobs"]}


def test_targeted_offer_only_shows_to_audience(world):
    jid = _mk_open_job(world, offer_audience=[A_CID])
    assert jid in _open_ids(_Cleaner(A_UID, A_CID))       # invited → sees it
    assert jid not in _open_ids(_Cleaner(B_UID, B_CID))   # not invited → hidden


def test_empty_audience_shows_everyone(world):
    jid = _mk_open_job(world, offer_audience=[])
    assert jid in _open_ids(_Cleaner(A_UID, A_CID))
    assert jid in _open_ids(_Cleaner(B_UID, B_CID))
    # None behaves the same as [].
    jid2 = _mk_open_job(world, offer_audience=None)
    assert jid2 in _open_ids(_Cleaner(B_UID, B_CID))


def test_targeting_is_visibility_not_assignment(world):
    """A targeted sub sees an OFFER to ask for — not an assignment."""
    jid = _mk_open_job(world, offer_audience=[A_CID])
    day = _as(_Cleaner(A_UID, A_CID)).get("/api/crew/my-day").json()
    _clear()
    row = next(j for j in day["open_jobs"] if j["id"] == jid)
    assert row["open"] is True and row["my_claim_request"] is None  # must still ask
    # Not assigned to anyone, and access details still hidden (offer, not order).
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    assert (j.cleaner_ids or []) == []
    db.close()
    assert row.get("house_code") is None and row.get("access_notes") is None


def test_office_can_set_and_clear_audience_and_it_validates(world):
    jid = _mk_open_job(world, offer_audience=None)
    office = _as(_Admin())
    # Target Ada only.
    r = office.patch(f"/api/jobs/{jid}", json={"offer_audience": [A_CID]})
    assert r.status_code == 200, r.text
    assert r.json()["offer_audience"] == [A_CID]
    _clear()
    assert jid in _open_ids(_Cleaner(A_UID, A_CID))
    assert jid not in _open_ids(_Cleaner(B_UID, B_CID))

    # Clear back to everyone with an explicit null (CLEARABLE_FIELDS).
    office = _as(_Admin())
    r = office.patch(f"/api/jobs/{jid}", json={"offer_audience": None})
    assert r.status_code == 200 and r.json()["offer_audience"] == []
    _clear()
    assert jid in _open_ids(_Cleaner(B_UID, B_CID))

    # An audience of only-unknown ids is refused (would hide the job from all).
    office = _as(_Admin())
    assert office.patch(f"/api/jobs/{jid}",
                        json={"offer_audience": ["CT-nobody"]}).status_code == 400
    _clear()
