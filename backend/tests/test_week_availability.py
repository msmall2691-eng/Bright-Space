"""Week-anchored crew availability (cleaner_week_availability, Phase 4b).

The rules under test, straight from the three-lens design review:
- LOCK: a week is writable only BEFORE it starts (business clock); current
  and past weeks 409 — for saves AND for the revert-to-template delete.
- SNAP: any date in a week resolves to its Monday server-side — a mid-week
  week_start can neither dodge the lock nor strand a row the resolver
  misses.
- MASK: an explicit week row shadows the template for its week in BOTH
  directions — marking a usually-off day available makes it free (the
  volunteer case), and marking a day off yields the firm "unavailable"
  status, which outranks same_day.
- CONTRADICTION: saving a week that no longer covers an already-assigned
  job succeeds but reports the job back (and notifies the office).
- Other orgs' week rows are invisible to the resolver.
"""
import uuid
from datetime import timedelta, time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import CleanerAvailability, CleanerWeekAvailability, Client, Property, Job
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today, week_monday


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9990, 1, "admin", "active", True
    email = "admin@example.com"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _next_monday():
    return week_monday(business_today()) + timedelta(weeks=1)


@pytest.fixture
def cid():
    cid = f"CT-wk-{uuid.uuid4().hex[:6]}"
    yield cid
    db = SessionLocal()
    db.query(CleanerWeekAvailability).filter(CleanerWeekAvailability.cleaner_id == cid).delete(synchronize_session=False)
    db.query(CleanerAvailability).filter(CleanerAvailability.cleaner_id == cid).delete(synchronize_session=False)
    db.commit(); db.close()


def test_lock_current_and_past_weeks(cid):
    today = business_today()
    this_monday = week_monday(today)
    try:
        api = _as(_Cleaner(9991, cid))
        # Current week: locked for save and for revert.
        r = api.put("/api/crew/me/availability/week",
                    json={"week_start": this_monday.isoformat(), "week": {}})
        assert r.status_code == 409
        assert "locked" in r.json()["detail"]
        assert r.headers.get("X-First-Editable-Week") == _next_monday().isoformat()
        assert api.delete(f"/api/crew/me/availability/week?week_start={this_monday.isoformat()}").status_code == 409
        # Past week: locked. Next week: open.
        past = (this_monday - timedelta(weeks=1)).isoformat()
        assert api.put("/api/crew/me/availability/week",
                       json={"week_start": past, "week": {}}).status_code == 409
        assert api.put("/api/crew/me/availability/week",
                       json={"week_start": _next_monday().isoformat(), "week": {"mon": ["am"]}}).status_code == 200
    finally:
        _clear()


def test_midweek_date_snaps_to_monday(cid):
    nm = _next_monday()
    wednesday = nm + timedelta(days=2)
    try:
        api = _as(_Cleaner(9992, cid))
        r = api.put("/api/crew/me/availability/week",
                    json={"week_start": wednesday.isoformat(), "week": {"wed": ["am"]}})
        assert r.status_code == 200
        assert r.json()["week_start"] == nm.isoformat()   # echoed canonical Monday
        db = SessionLocal()
        rows = db.query(CleanerWeekAvailability).filter(
            CleanerWeekAvailability.cleaner_id == cid).all()
        db.close()
        assert [x.week_start for x in rows] == [nm]        # stored at the Monday

        # GET reflects it as an explicit ("set") week with the lock computed
        # server-side; the current week is always locked.
        payload = api.get("/api/crew/me/availability").json()
        assert payload["weeks"][0]["locked"] is True
        by_start = {w["week_start"]: w for w in payload["weeks"]}
        assert by_start[nm.isoformat()]["source"] == "set"
        assert by_start[nm.isoformat()]["locked"] is False
    finally:
        _clear()


def test_week_row_masks_template_both_directions(cid):
    nm = _next_monday()
    friday = nm + timedelta(days=4)
    try:
        api = _as(_Cleaner(9993, cid))
        # Template: Fridays OFF (weekdays on otherwise).
        api.put("/api/crew/me/availability",
                json={"week": {"mon": ["am", "pm"], "tue": ["am", "pm"], "wed": ["am", "pm"],
                               "thu": ["am", "pm"], "fri": []}})
        _clear()
        office = _as(_Admin())
        rows = {r["cleaner_id"]: r for r in
                office.get(f"/api/jobs/cleaner-availability?date={friday.isoformat()}").json()}
        assert rows[cid]["status"] == "usually_off"        # template tier, soft
        _clear()

        # Volunteer direction: week row opens that Friday fully → free
        # (absent from the payload), template masked.
        api = _as(_Cleaner(9993, cid))
        api.put("/api/crew/me/availability/week",
                json={"week_start": nm.isoformat(),
                      "week": {"mon": ["am", "pm"], "tue": ["am", "pm"], "wed": ["am", "pm"],
                               "thu": ["am", "pm"], "fri": ["am", "pm"]}})
        _clear()
        office = _as(_Admin())
        rows = {r["cleaner_id"]: r for r in
                office.get(f"/api/jobs/cleaner-availability?date={friday.isoformat()}").json()}
        assert cid not in rows                              # volunteer shows FREE
        _clear()

        # Firm direction: week row closes Friday → "unavailable", not usually_off.
        api = _as(_Cleaner(9993, cid))
        api.put("/api/crew/me/availability/week",
                json={"week_start": nm.isoformat(),
                      "week": {"mon": ["am", "pm"], "fri": []}})
        _clear()
        office = _as(_Admin())
        rows = {r["cleaner_id"]: r for r in
                office.get(f"/api/jobs/cleaner-availability?date={friday.isoformat()}").json()}
        assert rows[cid]["status"] == "unavailable"
        assert "set for this week" in rows[cid]["detail"]
    finally:
        _clear()


def test_save_reports_uncovered_assignment(cid):
    nm = _next_monday()
    friday = nm + timedelta(days=4)
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Wk {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"9 Oak {tag}", address=f"9 Oak {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=f"Fri clean {tag}",
            scheduled_date=friday, start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=[cid], status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids = (j.id, p.id, c.id); db.close()
    try:
        api = _as(_Cleaner(9994, cid))
        r = api.put("/api/crew/me/availability/week",
                    json={"week_start": nm.isoformat(), "week": {"mon": ["am"]}})
        assert r.status_code == 200                        # save allowed…
        uncovered = r.json()["uncovered_jobs"]
        assert [u["job_id"] for u in uncovered] == [ids[0]]  # …but the clash is reported
        assert uncovered[0]["scheduled_date"] == friday.isoformat()
    finally:
        _clear()
        db = SessionLocal()
        db.query(Job).filter(Job.id == ids[0]).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == ids[1]).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == ids[2]).delete(synchronize_session=False)
        db.commit(); db.close()


def test_other_orgs_week_rows_are_invisible(cid):
    nm = _next_monday()
    friday = nm + timedelta(days=4)
    db = SessionLocal()
    db.add(CleanerWeekAvailability(org_id=2, cleaner_id=cid, week_start=nm, week={"fri": []}))
    db.commit(); db.close()
    try:
        office = _as(_Admin())   # org 1
        rows = {r["cleaner_id"]: r for r in
                office.get(f"/api/jobs/cleaner-availability?date={friday.isoformat()}").json()}
        assert cid not in rows   # org 2's row never leaks into org 1's picture
    finally:
        _clear()
