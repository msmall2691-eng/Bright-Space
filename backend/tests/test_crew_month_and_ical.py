"""Crew month view, lead see-all flag, and personal iCal feeds.

Security is the story here:
- A plain cleaner's month is THEIR jobs only; a lead flagged by the admin
  (can_view_full_schedule) sees everyone's — but those rows carry
  names/times only (no door codes, access notes, client phone, or office
  notes; month rows omit those keys entirely).
- The flag is admin-set only: the users PATCH is admin-gated, so a cleaner
  cannot self-elevate.
- The .ics feed needs no login (calendar apps can't send headers) but the
  token is the credential: wrong token 404s, the feed contains only that
  cleaner's jobs, and NEVER door codes or office notes — people share
  calendars.
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, User
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _CleanerUser:
    def __init__(self, row):
        for k in ("id", "org_id", "role", "status", "active", "email",
                  "full_name", "cleaner_id", "can_view_full_schedule"):
            setattr(self, k, getattr(row, k))


class _Admin:
    id, org_id, role, status, active = 9960, 1, "admin", "active", True
    email = "admin@example.com"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def world():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    lead = User(email=f"lead-{tag}@x.com", full_name="Lead", role="cleaner",
                cleaner_id=f"CT-mi-{tag}-L", org_id=1, password_hash="x")
    solo = User(email=f"solo-{tag}@x.com", full_name="Solo", role="cleaner",
                cleaner_id=f"CT-mi-{tag}-S", org_id=1, password_hash="x")
    db.add_all([lead, solo]); db.commit(); db.refresh(lead); db.refresh(solo)
    c = Client(name=f"Mi {tag}", status="active", org_id=1, phone="207-555-0142")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"4 Pine {tag}", address=f"4 Pine {tag}",
                 org_id=1, house_code="7777", access_notes="Back porch key")
    db.add(p); db.commit(); db.refresh(p)
    today = business_today()
    j_lead = Job(client_id=c.id, property_id=p.id, job_type="residential",
                 title="Lead's job", scheduled_date=today, start_time=time(9, 0),
                 end_time=time(11, 0), cleaner_ids=[lead.cleaner_id],
                 status="scheduled", org_id=1, notes="office secret")
    j_solo = Job(client_id=c.id, property_id=p.id, job_type="residential",
                 title="Solo's job", scheduled_date=today, start_time=time(13, 0),
                 end_time=time(15, 0), cleaner_ids=[solo.cleaner_id],
                 status="scheduled", org_id=1, notes="another secret")
    db.add_all([j_lead, j_solo]); db.commit(); db.refresh(j_lead); db.refresh(j_solo)
    ids = {"users": [lead.id, solo.id], "clients": [c.id], "properties": [p.id],
           "jobs": [j_lead.id, j_solo.id]}
    out = {"lead": lead, "solo": solo, "j_lead": j_lead.id, "j_solo": j_solo.id,
           "today": today}
    db.close()
    yield out
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids["users"])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_month_scoping_and_lead_flag(world):
    t = world["today"]
    try:
        # Plain cleaner: own jobs only.
        solo = _as(_CleanerUser(world["solo"]))
        r = solo.get(f"/api/crew/schedule-month?year={t.year}&month={t.month}").json()
        ids = {j["id"] for j in r["jobs"]}
        assert world["j_solo"] in ids and world["j_lead"] not in ids
        assert r["see_all"] is False
        _clear()

        # Admin flips the lead flag through the normal users PATCH.
        admin = _as(_Admin())
        resp = admin.patch(f"/api/auth/users/{world['lead'].id}",
                           json={"can_view_full_schedule": True})
        assert resp.status_code == 200 and resp.json()["can_view_full_schedule"] is True
        _clear()

        # Lead now sees both — but the other cleaner's row is names/times
        # only: month rows never carry access details or office notes.
        db = SessionLocal()
        fresh_lead = db.query(User).filter(User.id == world["lead"].id).first()
        lead_view = _CleanerUser(fresh_lead); db.close()
        lead = _as(lead_view)
        r = lead.get(f"/api/crew/schedule-month?year={t.year}&month={t.month}").json()
        by_id = {j["id"]: j for j in r["jobs"]}
        assert {world["j_lead"], world["j_solo"]} <= set(by_id)
        other = by_id[world["j_solo"]]
        assert other["mine"] is False and "Solo" in other["cleaners"]
        for leaky in ("house_code", "access_notes", "notes", "client_phone"):
            assert leaky not in other
    finally:
        _clear()


def test_cleaner_cannot_self_elevate(world):
    try:
        solo = _as(_CleanerUser(world["solo"]))
        r = solo.patch(f"/api/auth/users/{world['solo'].id}",
                       json={"can_view_full_schedule": True})
        assert r.status_code == 403      # users PATCH is admin/manager only
    finally:
        _clear()


def test_personal_ical_feed(world):
    try:
        solo = _as(_CleanerUser(world["solo"]))
        url = solo.get("/api/crew/me/calendar-link").json()["url"]
        token_path = "/api/crew-cal/" + url.split("/api/crew-cal/")[1]
        _clear()

        # The feed itself needs NO auth — but only the right token works.
        anon = TestClient(app)
        ics = anon.get(token_path)
        assert ics.status_code == 200
        assert ics.headers["content-type"].startswith("text/calendar")
        body = ics.text
        assert f"UID:job-{world['j_solo']}@brightbase" in body     # own job in
        assert f"UID:job-{world['j_lead']}@brightbase" not in body  # others out
        assert "7777" not in body and "office secret" not in body   # no leaks
        assert anon.get("/api/crew-cal/not-a-real-token-000000.ics").status_code == 404

        # Rotation kills the old URL.
        solo = _as(_CleanerUser(world["solo"]))
        new_url = solo.post("/api/crew/me/calendar-link/rotate").json()["url"]
        _clear()
        assert anon.get(token_path).status_code == 404
        assert anon.get("/api/crew-cal/" + new_url.split("/api/crew-cal/")[1]).status_code == 200
    finally:
        _clear()
