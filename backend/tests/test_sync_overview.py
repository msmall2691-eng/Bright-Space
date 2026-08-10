"""build_sync_overview() — the read-only payload behind the Sync Control Center.

Exercises the aggregator directly (no HTTP) against a seeded schedule: one
recurring series with a materialized visit, two Airbnb feeds (one healthy, one
failing), and an imported turnover job. Asserts the channel shape, flow
directions, the failing-feed rollup, and that the ~14 background ticks are all
surfaced. Google/Connecteam aren't configured in tests, so their channels report
'disconnected' and the overall verdict is 'attention' — asserted explicitly so a
regression that hides the disconnected backbone is caught.
"""
import pytest
from datetime import date, timedelta, time

from database.db import SessionLocal
from database.models import (
    Client, Property, Job, RecurringSchedule, PropertyIcal, ICalEvent,
)
from modules.scheduling.sync_overview import build_sync_overview


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Sync Overview Test", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Unit 4", address="4 Bay St",
                 property_type="str", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    # Order matters: children before parents (FK).
    db.query(ICalEvent).filter(ICalEvent.property_id == p.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
    db.query(PropertyIcal).filter(PropertyIcal.property_id == p.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _job(db, c, p, **kw):
    kw.setdefault("status", "scheduled")
    kw.setdefault("job_type", "str_turnover")
    j = Job(client_id=c.id, property_id=p.id, title="J",
            start_time=time(10, 0), end_time=time(13, 0), **kw)
    db.add(j); db.commit(); db.refresh(j)
    return j


def _by_key(overview):
    return {ch["key"]: ch for ch in overview["channels"]}


def test_overview_shape_and_directions(ctx):
    db, c, p = ctx
    ov = build_sync_overview(db, 1)

    # Top-level contract.
    for k in ("overall", "headline", "master", "auto_pilot", "channels",
              "attention", "issues", "background_jobs"):
        assert k in ov, f"missing top-level key {k}"
    assert ov["master"] == "brightbase"

    ch = _by_key(ov)
    assert set(ch) == {"google", "connecteam", "airbnb", "recurring"}
    # Flow directions are the whole point of the redesign — pin them.
    assert ch["google"]["direction"] == "out"
    assert ch["connecteam"]["direction"] == "out"
    assert ch["airbnb"]["direction"] == "in"
    assert ch["recurring"]["direction"] == "internal"
    # Every channel advertises the automation key its pause toggle posts.
    for chan in ov["channels"]:
        assert chan["toggle_key"]
        assert chan["status"] in {"ok", "syncing", "paused", "attention", "disconnected"}


def test_background_ticks_are_all_surfaced(ctx):
    db, c, p = ctx
    ov = build_sync_overview(db, 1)
    jobs = ov["background_jobs"]
    # The "14 hidden hands" the operator couldn't see before.
    assert len(jobs) == 14
    for j in jobs:
        assert j["name"] and isinstance(j["cadence_minutes"], int)
        assert j["group"] in {"scheduling", "health", "messaging", "other"}
    # Auto-pilot exposes the exact toggle set the master switch flips.
    assert set(ov["auto_pilot"]["toggles"]) == {
        "gcal_auto_sync_enabled", "ical_auto_sync_enabled",
        "recurring_auto_generate_enabled", "sync_reconcile_enabled",
        "connecteam_auto_dispatch_enabled", "calendar_source_of_truth",
    }


def test_failing_feed_rolls_up_to_attention(ctx):
    db, c, p = ctx
    db.add(PropertyIcal(property_id=p.id, url="https://airbnb.test/ok.ics",
                        source="airbnb", active=True, last_sync_status="ok"))
    db.add(PropertyIcal(property_id=p.id, url="https://airbnb.test/bad.ics",
                        source="vrbo", active=True, last_sync_status="failed",
                        last_sync_error="403 Forbidden"))
    db.commit()

    ov = build_sync_overview(db, 1)
    airbnb = _by_key(ov)["airbnb"]
    assert airbnb["feed_count"] == 2
    assert airbnb["backlog"] == 1          # one feed failing
    assert airbnb["status"] == "attention"
    assert any(a["key"] == "feeds_failing" for a in ov["attention"])


def test_recurring_and_turnover_counts(ctx):
    db, c, p = ctx
    future = date.today() + timedelta(days=2)

    rs = RecurringSchedule(client_id=c.id, property_id=p.id, job_type="residential",
                           title="Weekly", address="4 Bay St", frequency="weekly",
                           day_of_week=1, start_time=time(9, 0), end_time=time(11, 0),
                           active=True)
    db.add(rs); db.commit(); db.refresh(rs)
    # Distinct job_type from the turnover below — same property + date is allowed
    # only when job_type differs (jobs unique on property_id, date, job_type).
    _job(db, c, p, scheduled_date=future, recurring_schedule_id=rs.id, job_type="residential")

    feed = PropertyIcal(property_id=p.id, url="https://airbnb.test/a.ics",
                        source="airbnb", active=True, last_sync_status="ok")
    db.add(feed); db.commit(); db.refresh(feed)
    ev = ICalEvent(property_id=p.id, property_ical_id=feed.id,
                   uid="airbnb_1@airbnb.com", event_type="reservation",
                   checkout_date=future.isoformat())
    db.add(ev); db.commit(); db.refresh(ev)
    _job(db, c, p, scheduled_date=future, ical_event_id=ev.id)

    ov = build_sync_overview(db, 1)
    ch = _by_key(ov)
    assert ch["recurring"]["active_series"] >= 1
    assert ch["recurring"]["upcoming_visits"] >= 1
    assert ch["airbnb"]["turnovers_upcoming"] >= 1


def test_disconnected_backbone_is_attention(ctx):
    # Google isn't configured under test env → the backbone is down, so the
    # overall verdict must never read a calm 'ok', and the attention list must
    # name it. (Guards the _sync_overall wiring.)
    db, c, p = ctx
    ov = build_sync_overview(db, 1)
    assert ov["overall"] == "attention"
    assert _by_key(ov)["google"]["status"] == "disconnected"
    assert any(a["key"] == "google_disconnected" for a in ov["attention"])
