"""Crew-mobile wave: assignment pushes + the Chat-tab unread count.

Covers the event-driven Web Push hooks added at the canonical assignment
write sites (no polling tick — scheduling-invariants R1):

  * PATCH /api/jobs/{id} adding a cleaner pushes "New job for you" to the
    ADDED cleaner only — never to crew already on the job, and never on an
    unrelated edit (that would train everyone to ignore notifications).
  * POST /api/jobs with cleaner_ids pushes to each assigned cleaner.
  * The payload NEVER carries access details (door codes, access notes,
    address) — lock screens are world-readable.
  * An assigned crew ID with no linked login is skipped, not a 500.
  * /api/crew/my-day carries `unread_messages` (office messages not yet
    read) so the crew Chat tab can badge; reading the thread clears it.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, CrewMessage, Job, Property, User
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Office:
    def __init__(self, uid):
        self.id, self.org_id, self.role = uid, 1, "admin"
        self.status, self.active = "active", True
        self.email = f"office-{uid}@example.com"
        self.full_name = f"Office {uid}"
        self.cleaner_id = None


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role = uid, 1, "cleaner"
        self.status, self.active = "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def ids():
    made = {"clients": [], "properties": [], "jobs": [], "users": [], "messages": []}
    yield made
    db = SessionLocal()
    db.query(CrewMessage).filter(CrewMessage.id.in_(made["messages"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture
def pushes(monkeypatch):
    """Capture notify_user calls at the push_service seam. crew_notify resolves
    both names at call time (function-local import), so patching the module
    attributes intercepts the real path, VAPID keys or not."""
    from services import push_service
    sent = []

    def fake_notify_user(user_id, title, body, *, url="/", tag=None):
        sent.append({"user_id": user_id, "title": title, "body": body,
                     "url": url, "tag": tag})
        return 1

    monkeypatch.setattr(push_service, "push_enabled", lambda: True)
    monkeypatch.setattr(push_service, "notify_user", fake_notify_user)
    return sent


def _mk_cleaner_user(ids, cleaner_id):
    db = SessionLocal()
    u = User(email=f"crew-{uuid.uuid4().hex[:10]}@example.com", role="cleaner",
             org_id=1, cleaner_id=cleaner_id, status="active", active=True,
             full_name=f"Crew {cleaner_id}")
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id); uid = u.id; db.close()
    return uid


def _mk_job(ids, cleaner_ids, *, house_code="7741#", access_notes="key under the blue pot"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Push {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"Push House {tag}", address="12 Secret Ln",
                 property_type="residential", house_code=house_code,
                 access_notes=access_notes, org_id=1)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title=f"Clean {tag}", scheduled_date=business_today() + timedelta(days=3),
            start_time=dtime(9, 0), end_time=dtime(12, 0),
            cleaner_ids=list(cleaner_ids), status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid, pname = j.id, p.name; db.close()
    return jid, pname


def test_patch_added_cleaner_gets_push_others_dont(ids, pushes):
    cid_a, cid_b = f"PU-{uuid.uuid4().hex[:8]}", f"PU-{uuid.uuid4().hex[:8]}"
    _mk_cleaner_user(ids, cid_a)
    uid_b = _mk_cleaner_user(ids, cid_b)
    jid, pname = _mk_job(ids, [cid_a])

    api = _as(_Office(97001))
    try:
        r = api.patch(f"/api/jobs/{jid}", json={"cleaner_ids": [cid_a, cid_b]})
        assert r.status_code == 200
    finally:
        _clear()

    assert len(pushes) == 1                      # only the ADDED cleaner
    got = pushes[0]
    assert got["user_id"] == uid_b
    assert got["title"] == "New job for you"
    assert pname in got["body"]                  # where, by property name
    assert got["url"] == "/my-day"
    assert got["tag"] == f"job-assign-{jid}"


def test_push_payload_never_carries_access_details(ids, pushes):
    cid = f"PU-{uuid.uuid4().hex[:8]}"
    _mk_cleaner_user(ids, cid)
    jid, _ = _mk_job(ids, [], house_code="9911#", access_notes="lockbox on the gas meter")

    api = _as(_Office(97002))
    try:
        assert api.patch(f"/api/jobs/{jid}", json={"cleaner_ids": [cid]}).status_code == 200
    finally:
        _clear()

    assert len(pushes) == 1
    blob = (pushes[0]["title"] + " " + pushes[0]["body"]).lower()
    assert "9911" not in blob
    assert "lockbox" not in blob
    assert "gas meter" not in blob
    assert "12 secret ln" not in blob            # address stays off lock screens too


def test_unrelated_edit_and_unchanged_assignment_stay_quiet(ids, pushes):
    cid = f"PU-{uuid.uuid4().hex[:8]}"
    _mk_cleaner_user(ids, cid)
    jid, _ = _mk_job(ids, [cid])

    api = _as(_Office(97003))
    try:
        assert api.patch(f"/api/jobs/{jid}", json={"notes": "bring the tall ladder"}).status_code == 200
        assert api.patch(f"/api/jobs/{jid}", json={"cleaner_ids": [cid]}).status_code == 200
    finally:
        _clear()
    assert pushes == []


def test_create_job_pushes_each_assigned_cleaner(ids, pushes):
    cid_a, cid_b = f"PU-{uuid.uuid4().hex[:8]}", f"PU-{uuid.uuid4().hex[:8]}"
    uid_a = _mk_cleaner_user(ids, cid_a)
    uid_b = _mk_cleaner_user(ids, cid_b)
    db = SessionLocal()
    c = Client(name=f"Push {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    client_id = c.id; db.close()

    d = (business_today() + timedelta(days=4)).isoformat()
    api = _as(_Office(97004))
    try:
        r = api.post("/api/jobs", json={
            "client_id": client_id, "title": "New assigned clean",
            "scheduled_date": d, "start_time": "09:00", "end_time": "12:00",
            "cleaner_ids": [cid_a, cid_b],
        })
        assert r.status_code == 201, r.text
        ids["jobs"].append(r.json()["id"])
        # create_job may auto-create a default property for the client
        if r.json().get("property_id"):
            ids["properties"].append(r.json()["property_id"])
    finally:
        _clear()

    assert {p["user_id"] for p in pushes} == {uid_a, uid_b}
    assert all(p["title"] == "New job for you" for p in pushes)


def test_unlinked_crew_id_is_skipped_not_a_500(ids, pushes):
    jid, _ = _mk_job(ids, [])
    api = _as(_Office(97005))
    try:
        r = api.patch(f"/api/jobs/{jid}", json={"cleaner_ids": [f"PU-nobody-{uuid.uuid4().hex[:6]}"]})
        assert r.status_code == 200
    finally:
        _clear()
    assert pushes == []


def test_my_day_unread_messages_badge_and_clear(ids):
    cid = f"PU-{uuid.uuid4().hex[:8]}"
    uid = _mk_cleaner_user(ids, cid)

    db = SessionLocal()
    for sender, body, read in (("office", "Schedule change tomorrow", None),
                               ("office", "Don't forget the key drop", None),
                               ("cleaner", "Got it!", None)):
        m = CrewMessage(org_id=1, user_id=uid, sender=sender,
                        sender_name="x", body=body, read_at=read)
        db.add(m); db.commit(); db.refresh(m); ids["messages"].append(m.id)
    db.close()

    api = _as(_Cleaner(uid, cid))
    try:
        r = api.get("/api/crew/my-day")
        assert r.status_code == 200
        assert r.json()["unread_messages"] == 2   # office-sent, unread only

        assert api.get("/api/crew/messages").status_code == 200  # reading marks read
        assert api.get("/api/crew/my-day").json()["unread_messages"] == 0
    finally:
        _clear()
