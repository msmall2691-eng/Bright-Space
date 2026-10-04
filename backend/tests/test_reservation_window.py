"""The reservation fetch behind turnover booking details is bounded by date.

get_jobs() used to load EVERY reservation ever recorded for any property with
a turnover in view — on every Schedule load and every 45-second poll. The set
only grew, so the query got slower every month the business ran. These tests
pin the bound and, more importantly, pin the two things the bound must NOT
break: an in-window booking still matches, and a MOVED turnover still finds
the booking it is linked to even though that booking's checkout now sits
before the window.
"""
import uuid
from datetime import date, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, ICalEvent, Job, Property
from modules.scheduling.router import _reservation_events


@pytest.fixture
def seeded():
    db = SessionLocal()
    ids = {"clients": [], "properties": [], "jobs": [], "events": []}
    c = Client(name=f"Res {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"STR {uuid.uuid4().hex[:6]}",
                 address="1 Test St", property_type="str", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id)
    yield db, c.id, p.id, ids
    db.query(ICalEvent).filter(ICalEvent.id.in_(ids["events"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _event(db, ids, pid, checkin, checkout):
    ev = ICalEvent(property_id=pid, org_id=1, uid=f"uid_{uuid.uuid4().hex[:8]}",
                   event_type="reservation",
                   checkin_date=checkin.isoformat(), checkout_date=checkout.isoformat())
    db.add(ev); db.commit(); db.refresh(ev)
    ids["events"].append(ev.id)
    return ev


def test_history_is_not_loaded(seeded):
    """Two years of dead bookings must not ride along with this week's fetch."""
    db, _cid, pid, ids = seeded
    today = date.today()
    stale = _event(db, ids, pid, today - timedelta(days=730), today - timedelta(days=727))
    live = _event(db, ids, pid, today, today + timedelta(days=3))

    got = _reservation_events(db, [pid], since=today)[pid]
    got_ids = {e.id for e in got}
    assert live.id in got_ids
    assert stale.id not in got_ids


def test_future_bookings_still_come_back(seeded):
    """Nothing bounds the fetch above — next-arrival lookup reaches past the
    window on purpose."""
    db, _cid, pid, ids = seeded
    today = date.today()
    far = _event(db, ids, pid, today + timedelta(days=200), today + timedelta(days=205))
    got = _reservation_events(db, [pid], since=today)[pid]
    assert far.id in {e.id for e in got}


def test_moved_turnover_keeps_its_linked_booking(seeded):
    """A turnover the office moved forward still points at its original
    booking through Job.ical_event_id. That booking's checkout now sits BEFORE
    the window, so the date bound alone would drop it — it must be fetched by
    id instead."""
    db, _cid, pid, ids = seeded
    today = date.today()
    old = _event(db, ids, pid, today - timedelta(days=10), today - timedelta(days=6))

    got = _reservation_events(db, [pid], since=today, linked_ids=[old.id])[pid]
    assert old.id in {e.id for e in got}

    # ...and without the link it is correctly out of scope.
    assert _reservation_events(db, [pid], since=today).get(pid, []) == []


def test_sorted_by_checkin_for_next_arrival(seeded):
    db, _cid, pid, ids = seeded
    today = date.today()
    later = _event(db, ids, pid, today + timedelta(days=9), today + timedelta(days=12))
    sooner = _event(db, ids, pid, today + timedelta(days=2), today + timedelta(days=5))
    got = _reservation_events(db, [pid], since=today)[pid]
    assert [e.id for e in got] == [sooner.id, later.id]


def test_no_properties_is_no_query(seeded):
    db, *_ = seeded
    assert _reservation_events(db, [], since=date.today()) == {}
    assert _reservation_events(db, None) == {}
