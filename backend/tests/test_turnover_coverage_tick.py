"""Proactive daily turnover-coverage check (scheduler.turnover_coverage_tick).

Verifies it flags a future guest checkout with no active turnover, and goes
quiet once the turnover exists. Read-only — no feed fetch.
"""
from datetime import date, time, timedelta

from database.db import SessionLocal
from database.models import Client, Property, ICalEvent, Job, PropertyIcal
from scheduler import turnover_coverage_tick


def _seed(db):
    c = Client(name="Coverage Tick Test", email="ct@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Pier House", address="1 Pier Rd",
                 property_type="str", active=True)
    db.add(p); db.commit(); db.refresh(p)
    # turnover_coverage_tick only considers properties that have an active
    # PropertyIcal feed — give the test property one.
    db.add(PropertyIcal(property_id=p.id, url="https://example.com/cov.ics",
                        source="airbnb", active=True))
    db.commit(); db.refresh(p)
    return c, p


def test_flags_uncovered_checkout_then_clears_when_turnover_exists():
    db = SessionLocal()
    try:
        c, p = _seed(db)
        checkout = (date.today() + timedelta(days=9))
        # A future reservation in the feed store, but no turnover job yet.
        db.add(ICalEvent(property_id=p.id, uid="cov-1@feed", summary="Reserved",
                         event_type="reservation",
                         checkout_date=checkout.isoformat(),
                         checkin_date=(checkout - timedelta(days=2)).isoformat()))
        db.commit()

        res = turnover_coverage_tick()
        mine = next((f for f in res.get("flagged", []) if f["property_id"] == p.id), None)
        assert mine is not None, "expected the uncovered checkout to be flagged"
        assert checkout.isoformat() in mine["missing"]

        # Add the turnover → next check is clean for this property.
        db.add(Job(client_id=c.id, property_id=p.id, job_type="str_turnover",
                   title="Turnover", scheduled_date=checkout,
                   start_time=time(10, 0), end_time=time(13, 0), status="scheduled"))
        db.commit()

        res2 = turnover_coverage_tick()
        mine2 = next((f for f in res2.get("flagged", []) if f["property_id"] == p.id), None)
        assert mine2 is None, "covered property should not be flagged"
    finally:
        db.rollback()
        db.query(Job).filter(Job.property_id == p.id).delete(synchronize_session=False)
        db.query(ICalEvent).filter(ICalEvent.property_id == p.id).delete(synchronize_session=False)
        db.query(PropertyIcal).filter(PropertyIcal.property_id == p.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_failing_feed_is_flagged_even_with_no_missing_dates():
    """A feed outage makes stored events stale, so coverage can't be trusted —
    the property must be flagged even if the (stale) data looks fully covered."""
    db = SessionLocal()
    try:
        c, p = _seed(db)
        db.add(PropertyIcal(property_id=p.id, url="https://example.com/f.ics",
                            source="airbnb", active=True, last_sync_status="failed",
                            last_sync_error="boom"))
        db.commit()

        res = turnover_coverage_tick()
        mine = next((f for f in res.get("flagged", []) if f["property_id"] == p.id), None)
        assert mine is not None, "a property with a failing feed must be flagged"
        assert mine.get("feed_errors"), "feed_errors should name the failing feed"
        assert mine["missing"] == []  # no missing dates, but still unhealthy
    finally:
        db.rollback()
        db.query(PropertyIcal).filter(PropertyIcal.property_id == p.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit()
        db.close()
