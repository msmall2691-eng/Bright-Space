"""Cancelling a recurring series vs pausing it (migration 096).

The two used to write byte-identical rows — both set `active=False`, and only
the button copy differed — so a series the owner CANCELLED came back to the
list reading "Paused" and stayed there. Reported in her words: "when I try to
cancel or delete them they dont go away".

`cancelled_at` is what tells them apart. What's pinned here is that it changes
only the NAME: `active` remains the single authority on whether visits are
generated, cancelling deletes no visits (scheduling-invariants R7), and
resuming clears the stamp so a working series can't sit there labelled
Cancelled.
"""
import uuid
from datetime import time

from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, RecurringSchedule

client = TestClient(app)


def _seed_series(db, org_id=1):
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"CancelTest {tag}", status="active",
               email=f"cancel-{tag}@example.com", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    # A property is not optional here: generation inserts Jobs, and a Job with
    # no property_id fails the NOT NULL and is swallowed by the loop's
    # race-safe IntegrityError handler — the endpoint then reports a cheerful
    # "0 created" and the test reads as "generation is broken".
    p = Property(client_id=c.id, name=f"Cancel House {tag}", address="1 Cancel Rd",
                 property_type="residential", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, title=f"Cancel Test {tag}", job_type="residential",
        frequency="weekly", days_of_week=[2], day_of_week=2,
        start_time=time(9, 0), end_time=time(12, 0), active=True,
        generate_weeks_ahead=8,
        address="1 Cancel Rd", org_id=org_id)
    db.add(sched); db.commit(); db.refresh(sched)
    return c, p, sched


def _cleanup(db, c, p, sched):
    db.query(Job).filter(Job.recurring_schedule_id == sched.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id == sched.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_cancelling_a_series_is_distinguishable_from_pausing_it():
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        assert sched.cancelled_at is None, "a live series is not cancelled"

        # Pause: stops generation, but is NOT a cancellation.
        assert client.patch(f"/api/recurring/{sched.id}",
                            json={"active": False}).status_code == 200
        db.expire_all()
        paused = db.query(RecurringSchedule).get(sched.id)
        assert paused.active is False and paused.cancelled_at is None

        # Cancel: same effect on generation, and now says so.
        assert client.delete(f"/api/recurring/{sched.id}").status_code == 204
        db.expire_all()
        cancelled = db.query(RecurringSchedule).get(sched.id)
        assert cancelled.active is False
        assert cancelled.cancelled_at is not None, \
            "cancel must be tellable from pause, or the row reads 'Paused'"
    finally:
        _cleanup(db, c, p, sched)


def test_the_api_reports_it_so_the_list_can_label_the_row():
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.delete(f"/api/recurring/{sched.id}")
        row = next(r for r in client.get("/api/recurring").json()
                   if r["id"] == sched.id)
        assert row["cancelled_at"], "the list can't say 'Cancelled' without it"
        assert row["active"] is False
    finally:
        _cleanup(db, c, p, sched)


def test_resuming_a_cancelled_series_un_cancels_it():
    # Otherwise it generates visits while the screen still calls it Cancelled.
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.delete(f"/api/recurring/{sched.id}")
        res = client.patch(f"/api/recurring/{sched.id}", json={"active": True})
        assert res.status_code == 200
        assert res.json()["cancelled_at"] is None
        db.expire_all()
        assert db.query(RecurringSchedule).get(sched.id).cancelled_at is None
    finally:
        _cleanup(db, c, p, sched)


def test_cancelling_generates_nothing_further_and_deletes_no_visits():
    # The whole point of a soft cancel: `active` stays the single authority on
    # generation, and visits already on the calendar are never removed (R7).
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        db.expire_all()
        before = db.query(Job).filter(Job.recurring_schedule_id == sched.id).count()
        assert before > 0, "a live weekly series should have produced visits"

        client.delete(f"/api/recurring/{sched.id}")
        client.post(f"/api/recurring/{sched.id}/generate")
        db.expire_all()
        after = db.query(Job).filter(Job.recurring_schedule_id == sched.id).count()
        assert after == before, "cancelling must neither generate nor delete visits"
    finally:
        _cleanup(db, c, p, sched)


def test_generate_all_skips_a_cancelled_series():
    # generate-all filters on `active`, which cancel already clears — this
    # pins that the new column didn't become a second, ignorable gate.
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.delete(f"/api/recurring/{sched.id}")
        client.post("/api/recurring/generate-all")
        db.expire_all()
        assert db.query(Job).filter(Job.recurring_schedule_id == sched.id).count() == 0
    finally:
        _cleanup(db, c, p, sched)


# ── a decided series is not a to-do ─────────────────────────────────────────

def _paused_no_upcoming(db, sched, **kw):
    """Put a series in the exact state stale_paused looks for."""
    sched.active = False
    for k, v in kw.items():
        setattr(sched, k, v)
    db.commit(); db.refresh(sched)


def _codes(schedule_id):
    from services.recurring_guards import audit_series
    from database.db import SessionLocal as _SL
    db = _SL()
    try:
        row = next((i for i in audit_series(db, 1)["issues"]
                    if i["schedule_id"] == schedule_id), None)
        return [p["code"] for p in (row or {}).get("problems", [])]
    finally:
        db.close()


def test_a_cancelled_series_stops_being_reported_as_a_leftover():
    """The fix has to be able to clear the finding.

    Cancelling sets active=False (already false) and leaves `upcoming` at zero,
    so before this the series still matched `stale_paused` and the scan
    reported the same count no matter how many times the owner cancelled —
    while the suggestion text promised cancelling "removes it from the list".
    """
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        _paused_no_upcoming(db, sched)
        assert "stale_paused" in _codes(sched.id), "seed must actually be a leftover"

        client.delete(f"/api/recurring/{sched.id}")
        assert "stale_paused" not in _codes(sched.id)
    finally:
        _cleanup(db, c, p, sched)


def test_a_series_that_reached_its_end_date_is_not_a_leftover_either():
    # It didn't just stop — it finished. Marking a batch as ended used to move
    # them from "ended but active" straight into "leftover", so the count never
    # moved there either.
    from datetime import date, timedelta
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        _paused_no_upcoming(db, sched,
                            series_end_date=date.today() - timedelta(days=30))
        assert "stale_paused" not in _codes(sched.id)
    finally:
        _cleanup(db, c, p, sched)


def test_a_series_that_merely_stopped_is_still_a_leftover():
    # The finding still has to fire for the case it exists for: paused, nothing
    # upcoming, and no recorded reason why.
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        _paused_no_upcoming(db, sched)
        assert "stale_paused" in _codes(sched.id)
    finally:
        _cleanup(db, c, p, sched)
