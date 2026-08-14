"""Crew self-service: time-off requests, private notes, office chat.

The trust boundaries under test:
- A time-off REQUEST does not count as off anywhere until the office
  approves it (the availability resolver ignores 'requested' rows); after
  approval it outranks everything, as time off always has.
- Pending requests can be withdrawn by their owner; approved ones can't.
- Private notes are invisible to the office list, the crew feed, and other
  cleaners — owner-only in every direction.
- The message thread is per-cleaner: crew endpoints reach only their own
  thread; the office endpoints are office-role only.
"""
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import CleanerTimeOff, CrewDoc, CrewMessage, User
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id, name="Cleaner Test"):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = name
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9930, 1, "admin", "active", True
    email = "admin@example.com"
    full_name = "The Office"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def cleanup():
    tag = uuid.uuid4().hex[:6]
    made = {"tag": tag, "users": [], "docs": []}
    yield made
    db = SessionLocal()
    db.query(CleanerTimeOff).filter(CleanerTimeOff.cleaner_id.like(f"CT-ss-{tag}%")).delete(synchronize_session=False)
    if made["docs"]:
        db.query(CrewDoc).filter(CrewDoc.id.in_(made["docs"])).delete(synchronize_session=False)
    if made["users"]:
        db.query(CrewMessage).filter(CrewMessage.user_id.in_(made["users"])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_time_off_request_lifecycle(cleanup):
    cid = f"CT-ss-{cleanup['tag']}-1"
    day = (business_today() + timedelta(days=10)).isoformat()
    try:
        crew = _as(_Cleaner(9931, cid))
        r = crew.post("/api/crew/me/time-off",
                      json={"start_date": day, "end_date": day, "reason": "wedding"})
        assert r.status_code == 201 and r.json()["status"] == "requested"
        entry_id = r.json()["id"]
        _clear()

        # Not approved yet → the availability surface does NOT show them off.
        office = _as(_Admin())
        rows = {x["cleaner_id"]: x for x in
                office.get(f"/api/jobs/cleaner-availability?date={day}").json()}
        assert cid not in rows or rows[cid]["status"] != "off"

        # Approve → now it's real time off, top priority.
        r = office.patch(f"/api/jobs/time-off/{entry_id}/status", json={"status": "approved"})
        assert r.status_code == 200 and r.json()["status"] == "approved"
        rows = {x["cleaner_id"]: x for x in
                office.get(f"/api/jobs/cleaner-availability?date={day}").json()}
        assert rows[cid]["status"] == "off"
        _clear()

        # Approved requests can't be withdrawn by the cleaner.
        crew = _as(_Cleaner(9931, cid))
        assert crew.delete(f"/api/crew/me/time-off/{entry_id}").status_code == 409
        # But a fresh pending one can.
        day2 = (business_today() + timedelta(days=20)).isoformat()
        rid = crew.post("/api/crew/me/time-off",
                        json={"start_date": day2, "end_date": day2}).json()["id"]
        assert crew.delete(f"/api/crew/me/time-off/{rid}").status_code == 200
    finally:
        _clear()


def test_private_notes_are_owner_only(cleanup):
    try:
        a = _Cleaner(9932, f"CT-ss-{cleanup['tag']}-2")
        cleanup["users"].append(a.id)
        crew_a = _as(a)
        note = crew_a.post("/api/crew/my-docs",
                           json={"title": "My door code tricks", "body": "secret stuff"}).json()
        cleanup["docs"].append(note["id"])
        assert note["title"] == "My door code tricks"
        _clear()

        # Office CRUD list never shows it.
        office = _as(_Admin())
        assert note["id"] not in {d["id"] for d in office.get("/api/crew-docs").json()}
        _clear()

        # Another cleaner's my-docs and the company feed never show it.
        b = _Cleaner(9933, f"CT-ss-{cleanup['tag']}-3")
        crew_b = _as(b)
        assert note["id"] not in {d["id"] for d in crew_b.get("/api/crew/my-docs").json()}
        assert note["id"] not in {d["id"] for d in crew_b.get("/api/crew/docs").json()}
        _clear()

        # Owner can edit and delete.
        crew_a = _as(a)
        r = crew_a.patch(f"/api/crew/my-docs/{note['id']}",
                         json={"title": "Updated", "body": "x"})
        assert r.status_code == 200 and r.json()["title"] == "Updated"
        assert crew_a.delete(f"/api/crew/my-docs/{note['id']}").status_code == 200
    finally:
        _clear()


def test_office_thread_roundtrip_and_roles(cleanup):
    a = _Cleaner(9934, f"CT-ss-{cleanup['tag']}-4", name="Thread Tester")
    cleanup["users"].append(a.id)
    db = SessionLocal()
    row = User(id=a.id, email=a.email, full_name=a.full_name, role="cleaner",
               cleaner_id=a.cleaner_id, org_id=1, password_hash="x")
    db.merge(row); db.commit(); db.close()
    try:
        crew = _as(a)
        r = crew.post("/api/crew/messages", json={"body": "Van won't start"})
        assert r.status_code == 201 and r.json()["sender"] == "cleaner"
        # Crew can't touch the office-side endpoints.
        assert crew.get(f"/api/crew/messages/{a.id}").status_code == 403
        _clear()

        office = _as(_Admin())
        thread = office.get(f"/api/crew/messages/{a.id}").json()
        assert [m["body"] for m in thread] == ["Van won't start"]
        r = office.post(f"/api/crew/messages/{a.id}", json={"body": "On it — take the truck"})
        assert r.status_code == 201 and r.json()["sender"] == "office"
        _clear()

        crew = _as(a)
        bodies = [m["body"] for m in crew.get("/api/crew/messages").json()]
        assert bodies == ["Van won't start", "On it — take the truck"]
    finally:
        _clear()
        db = SessionLocal()
        db.query(CrewMessage).filter(CrewMessage.user_id == a.id).delete(synchronize_session=False)
        db.query(User).filter(User.id == a.id).delete(synchronize_session=False)
        db.commit(); db.close()
