"""Economy-audit regression locks (H3, H5).

H3: a job PATCH only pushes to Google Calendar when a field the calendar
event actually carries changed — editing cleaners/notes-free fields must not
re-push an unchanged event (scheduling-invariants R4).

H5: the background iCal tick may skip re-parsing a feed whose bytes are
unchanged (body-hash short-circuit) — but ONLY the tick: default calls stay
full syncs, and the skip still reports the cached feed UIDs so the
cross-feed cancellation sweep never sees a synced feed as empty.
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Admin:
    id = None
    org_id = 1
    role = "admin"
    status, active = "active", True
    email = "owner@example.com"
    full_name = "Owner"
    cleaner_id = None


def _as_admin():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def made():
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_gcal_not_repushed_when_no_calendar_field_changed(made, monkeypatch):
    calls = []
    import integrations.google_calendar as gc
    monkeypatch.setattr(gc, "update_event", lambda *a, **k: calls.append(a) or True)

    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Econ {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    made["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"1 Econ St {tag}", address=f"1 Econ St {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    made["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, title=f"Econ clean {tag}",
            job_type="residential", status="scheduled", org_id=1,
            scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
            gcal_event_id="evt-econ-test")
    db.add(j); db.commit(); db.refresh(j)
    made["jobs"].append(j.id)
    jid = j.id
    db.close()

    try:
        api = _as_admin()
        # Cleaner assignment is NOT on the calendar event → no push.
        r = api.patch(f"/api/jobs/{jid}", json={"cleaner_ids": ["CT-1"]})
        assert r.status_code == 200
        assert calls == []

        # Moving the time IS a calendar change → exactly one push.
        r = api.patch(f"/api/jobs/{jid}", json={"start_time": "10:00", "end_time": "12:00"})
        assert r.status_code == 200
        assert len(calls) == 1
    finally:
        _clear()


def test_ical_unchanged_skip_is_tick_only_and_keeps_uids(monkeypatch):
    import integrations.ical_sync as ics

    ics._FEED_STATE.clear()
    url = f"https://example.com/{uuid.uuid4().hex}.ics"
    # One real reservation: it must count as "seen" (a 0-event feed is
    # classified as a partial fetch, which deliberately records no
    # change-detection state).
    body = (
        b"BEGIN:VCALENDAR\n"
        b"BEGIN:VEVENT\n"
        b"UID:econ-skip-test-1\n"
        b"DTSTART;VALUE=DATE:20990101\n"
        b"DTEND;VALUE=DATE:20990103\n"
        b"SUMMARY:Reserved\n"
        b"END:VEVENT\n"
        b"END:VCALENDAR\n"
    )
    fetches = []

    class _Resp:
        status_code = 200
        content = body
        headers = {}
        def raise_for_status(self): pass

    class _FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, u, **k):
            fetches.append(u)
            return _Resp()

    monkeypatch.setattr(ics, "_httpx", type("M", (), {"Client": _FakeClient}))

    from database.models import ICalEvent
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Skip {tag}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    prop = Property(client_id=c.id, name=f"Skip house {tag}",
                    address=f"1 Skip St {tag}", property_type="str")
    db.add(prop); db.commit(); db.refresh(prop)

    try:
        # Tick path, first sight of the feed: full parse, state recorded.
        r1 = ics._sync_ical_url(db, prop, url, allow_unchanged_skip=True)
        assert "error" not in r1 and not r1.get("unchanged")
        assert r1["events_seen"] == 1
        assert url in ics._FEED_STATE

        # Tick path, identical bytes: skipped before the parse, and the
        # cached UID set still reports the booking (cancellation-sweep input).
        fetch_count_before = len(fetches)
        r2 = ics._sync_ical_url(db, prop, url, allow_unchanged_skip=True)
        assert r2.get("unchanged") is True
        assert r2["jobs_created"] == 0
        assert "econ-skip-test-1" in r2["feed_uids"]
        assert len(fetches) == fetch_count_before + 1  # one HTTP GET, no re-parse

        # Manual path (default flag): NEVER skipped, even with identical bytes.
        r3 = ics._sync_ical_url(db, prop, url)
        assert not r3.get("unchanged")
    finally:
        ics._FEED_STATE.clear()
        db.rollback()
        db.query(Job).filter(Job.property_id == prop.id).delete(synchronize_session=False)
        db.query(ICalEvent).filter(ICalEvent.property_id == prop.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
