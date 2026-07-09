"""Coverage for Tier 3 roadmap items:

1. Single-job endpoints (GET /api/jobs/{id}, create/update) used to always
   return is_immediate_turnover=False / booking=None / next_arrival=None for
   str_turnover jobs — only the list endpoint (GET /api/jobs) computed the
   booking match. _job_to_dict_enriched fixes that.
2. turnover_lead_hours / turnover_lead_warning — a configurable buffer
   (Settings -> Automation) flagging "tight turnaround" turnovers that
   aren't same-day (is_immediate_turnover) but still cut it close.
3. Per-property iCal feed health rollup + turnovers_next_30d, surfaced by
   GET /api/properties and /api/properties/{id}.
"""
import uuid
from datetime import date, time, timedelta, datetime, timezone
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, PropertyIcal, ICalEvent, Job

client = TestClient(app)


def _seed_turnover(db, *, checkin_offset_days, checkin_time_override=None, end_time=time(13, 0)):
    """A str_turnover job whose checkout just happened, plus the next
    reservation's check-in `checkin_offset_days` after that checkout."""
    c = Client(name=f"Turnover Client {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Lead Time House", address="9 Lead St",
                 property_type="str", active=True,
                 check_in_time=checkin_time_override or "16:00")
    db.add(p); db.commit(); db.refresh(p)

    checkout = date(2026, 9, 10)
    j = Job(client_id=c.id, property_id=p.id, title="Turnover", job_type="str_turnover",
            scheduled_date=checkout, start_time=time(10, 0), end_time=end_time, status="scheduled")
    db.add(j); db.commit(); db.refresh(j)

    checkin = checkout + timedelta(days=checkin_offset_days)
    outgoing = ICalEvent(property_id=p.id, uid="out@feed", summary="Outgoing guest",
                         event_type="reservation", checkout_date=checkout.isoformat(),
                         checkin_date=(checkout - timedelta(days=3)).isoformat())
    incoming = ICalEvent(property_id=p.id, uid="in@feed", summary="Incoming guest",
                         event_type="reservation", checkin_date=checkin.isoformat(),
                         checkout_date=(checkin + timedelta(days=3)).isoformat())
    db.add_all([outgoing, incoming])
    db.commit()
    return c, p, j


def _cleanup(db, c, p, j, extra_jobs=None):
    for jj in (extra_jobs or []) + [j]:
        db.query(Job).filter(Job.id == jj.id).delete(synchronize_session=False)
    db.query(ICalEvent).filter(ICalEvent.property_id == p.id).delete(synchronize_session=False)
    db.query(PropertyIcal).filter(PropertyIcal.property_id == p.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


# ---------------------------------------------------------------------------
# Single-job endpoints now populate booking/next_arrival/is_immediate_turnover
# ---------------------------------------------------------------------------
def test_get_job_populates_immediate_turnover_for_same_day_checkin():
    db = SessionLocal()
    c, p, j = _seed_turnover(db, checkin_offset_days=0)
    try:
        r = client.get(f"/api/jobs/{j.id}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_immediate_turnover"] is True
        assert body["booking"] is not None
        assert body["next_arrival"] is not None
    finally:
        _cleanup(db, c, p, j)


def test_get_job_details_also_populates_booking_info():
    db = SessionLocal()
    c, p, j = _seed_turnover(db, checkin_offset_days=0)
    try:
        r = client.get(f"/api/jobs/{j.id}/details")
        assert r.status_code == 200, r.text
        assert r.json()["is_immediate_turnover"] is True
    finally:
        _cleanup(db, c, p, j)


def test_update_job_response_populates_booking_info():
    db = SessionLocal()
    c, p, j = _seed_turnover(db, checkin_offset_days=0)
    try:
        r = client.patch(f"/api/jobs/{j.id}", json={"notes": "bump"})
        assert r.status_code == 200, r.text
        assert r.json()["is_immediate_turnover"] is True
    finally:
        _cleanup(db, c, p, j)


def test_get_job_non_turnover_job_unaffected():
    db = SessionLocal()
    cli = Client(name=f"Plain Client {uuid.uuid4().hex[:6]}", status="active")
    db.add(cli); db.commit(); db.refresh(cli)
    p = Property(client_id=cli.id, name="Plain House", address="1 Plain St",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=cli.id, property_id=p.id, title="Regular clean", job_type="residential",
            scheduled_date=date(2026, 9, 10), start_time=time(9, 0), end_time=time(11, 0), status="scheduled")
    db.add(j); db.commit(); db.refresh(j)
    try:
        r = client.get(f"/api/jobs/{j.id}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_immediate_turnover"] is False
        assert body["booking"] is None
        assert body["turnover_lead_hours"] is None
    finally:
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == cli.id).delete(synchronize_session=False)
        db.commit(); db.close()


# ---------------------------------------------------------------------------
# turnover_lead_hours / turnover_lead_warning
# ---------------------------------------------------------------------------
def test_lead_hours_negative_for_same_day_checkin_and_flagged():
    """Checkout job ends 13:00; next guest checks in same day at the
    property's 16:00 default — only 2h, well under the 3h default buffer —
    and is_immediate_turnover is True besides."""
    db = SessionLocal()
    c, p, j = _seed_turnover(db, checkin_offset_days=0, end_time=time(14, 0))
    try:
        r = client.get(f"/api/jobs/{j.id}")
        body = r.json()
        assert body["turnover_lead_hours"] == 2.0
        assert body["turnover_lead_warning"] is True
    finally:
        _cleanup(db, c, p, j)


def test_lead_hours_tight_next_day_early_checkin_flagged():
    """Turnover ends 18:00 on day 0; next guest checks in at 08:00 the very
    next day — 14h gap, comfortably under the 3h... wait, use a genuinely
    tight case: end at 22:00, next check-in 08:00 next day = 10h. Still not
    tight at the 3h default, so use an explicit small buffer via settings."""
    db = SessionLocal()
    c, p, j = _seed_turnover(db, checkin_offset_days=1, checkin_time_override="08:00",
                             end_time=time(22, 0))
    try:
        r = client.get(f"/api/jobs/{j.id}")
        body = r.json()
        # 08:00 next day - 22:00 today = 10 hours.
        assert body["turnover_lead_hours"] == 10.0
        assert body["is_immediate_turnover"] is False
        assert body["turnover_lead_warning"] is False  # 10h > default 3h buffer

        # Raise the buffer to 12h via settings -> now it's flagged.
        r2 = client.post("/api/settings/automation", json={"turnover_lead_buffer_hours": 12})
        assert r2.status_code == 200, r2.text
        r3 = client.get(f"/api/jobs/{j.id}")
        assert r3.json()["turnover_lead_warning"] is True
    finally:
        client.post("/api/settings/automation", json={"turnover_lead_buffer_hours": 3})
        _cleanup(db, c, p, j)


def test_lead_hours_plenty_of_buffer_not_flagged():
    db = SessionLocal()
    c, p, j = _seed_turnover(db, checkin_offset_days=5, end_time=time(13, 0))
    try:
        r = client.get(f"/api/jobs/{j.id}")
        body = r.json()
        assert body["turnover_lead_hours"] > 100
        assert body["turnover_lead_warning"] is False
        assert body["is_immediate_turnover"] is False
    finally:
        _cleanup(db, c, p, j)


def test_get_jobs_list_also_computes_lead_hours():
    """The bulk get_jobs() path (property_check_in_time passed explicitly,
    avoiding a lazy-load per row) must agree with the single-job path."""
    db = SessionLocal()
    c, p, j = _seed_turnover(db, checkin_offset_days=0, end_time=time(14, 0))
    try:
        r = client.get("/api/jobs", params={"date_from": "2026-09-01", "date_to": "2026-09-30"})
        assert r.status_code == 200, r.text
        rows = r.json()
        mine = next((row for row in rows if row["id"] == j.id), None)
        assert mine is not None
        assert mine["turnover_lead_hours"] == 2.0
        assert mine["turnover_lead_warning"] is True
    finally:
        _cleanup(db, c, p, j)


# ---------------------------------------------------------------------------
# Automation settings round-trip
# ---------------------------------------------------------------------------
def test_automation_settings_persist_lead_buffer_hours():
    try:
        r = client.post("/api/settings/automation", json={"turnover_lead_buffer_hours": 5.5})
        assert r.status_code == 200, r.text
        r2 = client.get("/api/settings/automation")
        assert r2.json()["turnover_lead_buffer_hours"] == 5.5
    finally:
        client.post("/api/settings/automation", json={"turnover_lead_buffer_hours": 3})


# ---------------------------------------------------------------------------
# Property iCal health rollup + turnovers_next_30d
# ---------------------------------------------------------------------------
def _seed_property(db, property_type="str"):
    c = Client(name=f"Health Client {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Health House", address="1 Health Way",
                 property_type=property_type, active=True)
    db.add(p); db.commit(); db.refresh(p)
    return c, p


def _cleanup_property(db, c, p):
    db.query(Job).filter(Job.property_id == p.id).delete(synchronize_session=False)
    db.query(PropertyIcal).filter(PropertyIcal.property_id == p.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_property_with_no_active_feed_reports_no_feed():
    db = SessionLocal()
    c, p = _seed_property(db)
    try:
        r = client.get(f"/api/properties/{p.id}")
        assert r.status_code == 200, r.text
        assert r.json()["ical_health"] == "no_feed"
    finally:
        _cleanup_property(db, c, p)


def test_property_with_recent_ok_sync_reports_healthy():
    db = SessionLocal()
    c, p = _seed_property(db)
    db.add(PropertyIcal(property_id=p.id, url="https://example.com/h.ics", source="airbnb",
                        active=True, last_synced_at=datetime.now(timezone.utc), last_sync_status="ok"))
    db.commit()
    try:
        r = client.get(f"/api/properties/{p.id}")
        assert r.json()["ical_health"] == "healthy"
    finally:
        _cleanup_property(db, c, p)


def test_property_with_stale_sync_reports_stale():
    db = SessionLocal()
    c, p = _seed_property(db)
    db.add(PropertyIcal(property_id=p.id, url="https://example.com/s.ics", source="airbnb",
                        active=True,
                        last_synced_at=datetime.now(timezone.utc) - timedelta(hours=48),
                        last_sync_status="ok"))
    db.commit()
    try:
        r = client.get(f"/api/properties/{p.id}")
        assert r.json()["ical_health"] == "stale"
    finally:
        _cleanup_property(db, c, p)


def test_property_with_failing_sync_reports_stale():
    db = SessionLocal()
    c, p = _seed_property(db)
    db.add(PropertyIcal(property_id=p.id, url="https://example.com/f.ics", source="airbnb",
                        active=True, last_synced_at=datetime.now(timezone.utc),
                        last_sync_status="failed", last_sync_error="403 Forbidden"))
    db.commit()
    try:
        r = client.get(f"/api/properties/{p.id}")
        assert r.json()["ical_health"] == "stale"
    finally:
        _cleanup_property(db, c, p)


def test_non_str_property_has_no_health_field():
    db = SessionLocal()
    c, p = _seed_property(db, property_type="residential")
    try:
        r = client.get(f"/api/properties/{p.id}")
        body = r.json()
        assert body["ical_health"] is None
        assert body["turnovers_next_30d"] is None
    finally:
        _cleanup_property(db, c, p)


def test_turnovers_next_30d_counts_only_upcoming_uncancelled_turnovers():
    db = SessionLocal()
    c, p = _seed_property(db)
    today = date.today()
    in_window = Job(client_id=c.id, property_id=p.id, title="T1", job_type="str_turnover",
                    scheduled_date=today + timedelta(days=5), start_time=time(10, 0),
                    end_time=time(13, 0), status="scheduled")
    cancelled = Job(client_id=c.id, property_id=p.id, title="T2 (cancelled)", job_type="str_turnover",
                    scheduled_date=today + timedelta(days=6), start_time=time(10, 0),
                    end_time=time(13, 0), status="cancelled")
    out_of_window = Job(client_id=c.id, property_id=p.id, title="T3", job_type="str_turnover",
                        scheduled_date=today + timedelta(days=45), start_time=time(10, 0),
                        end_time=time(13, 0), status="scheduled")
    db.add_all([in_window, cancelled, out_of_window])
    db.commit()
    try:
        r = client.get(f"/api/properties/{p.id}")
        assert r.json()["turnovers_next_30d"] == 1

        # List endpoint (bulk path) must agree.
        r2 = client.get("/api/properties", params={"property_type": "str"})
        mine = next(row for row in r2.json() if row["id"] == p.id)
        assert mine["turnovers_next_30d"] == 1
    finally:
        _cleanup_property(db, c, p)
