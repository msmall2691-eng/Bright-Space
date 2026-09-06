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
from datetime import time, timedelta

from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, RecurringSchedule
from utils.dates import business_today

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


def _issues():
    """The whole scan, for assertions that need a finding's payload and not
    just its code."""
    from services.recurring_guards import audit_series
    from database.db import SessionLocal as _SL
    db = _SL()
    try:
        return audit_series(db, 1)["issues"]
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


# ── taking the visits off the calendar ──────────────────────────────────────
#
# "reoccuring bookings are not caceling or deleting ... and some still showing
# up on schedule even tho i deleted" — the owner, again, after the rename above
# shipped. The label was only ever half of it. Cancelling stops GENERATION;
# every visit already materialized stays on the schedule, and generation runs
# eight weeks ahead, so cancelling a weekly series left ~8 cleanings sitting
# there. The confirm text admitted it ("stays on the calendar until you remove
# them individually"), which describes a chore, not a cancellation.
#
# POST /{id}/cancel-upcoming is the second, explicit act — separate from
# DELETE so a Job never disappears as a side effect of an operation aimed at
# something else (scheduling-invariants R7).

def _dates(db, sched_id, status=None):
    q = db.query(Job).filter(Job.recurring_schedule_id == sched_id)
    if status:
        q = q.filter(Job.status == status)
    return sorted(j.scheduled_date for j in q.all())


def test_cancelling_the_upcoming_visits_clears_them_off_the_schedule():
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        db.expire_all()
        live = _dates(db, sched.id, "scheduled")
        assert len(live) > 1, "a weekly series generating 8 weeks out should have several"

        client.delete(f"/api/recurring/{sched.id}")
        res = client.post(f"/api/recurring/{sched.id}/cancel-upcoming")
        assert res.status_code == 200
        body = res.json()
        assert body["cancelled_count"] == len(live)
        # It reports what it did, per visit — this is what the confirm turns
        # into a sentence, and what makes the count checkable afterwards.
        assert sorted(v["scheduled_date"] for v in body["cancelled"]) == \
            [d.isoformat() for d in live]

        db.expire_all()
        assert _dates(db, sched.id, "scheduled") == [], "nothing may still be live"
    finally:
        _cleanup(db, c, p, sched)


def test_it_cancels_rather_than_deletes():
    # R7: the rows stay. An invoice, a payroll line or an activity entry can
    # point at any of them, and a vanished row takes those with it.
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        db.expire_all()
        before = db.query(Job).filter(Job.recurring_schedule_id == sched.id).count()

        client.post(f"/api/recurring/{sched.id}/cancel-upcoming")
        db.expire_all()
        after = db.query(Job).filter(Job.recurring_schedule_id == sched.id).count()
        assert after == before, "soft cancel: same rows, different status"
        assert all(j.status == "cancelled" for j in
                   db.query(Job).filter(Job.recurring_schedule_id == sched.id).all())
    finally:
        _cleanup(db, c, p, sched)


def test_a_completed_visit_is_never_touched():
    # It happened. The invoice and the payroll hours hanging off it are real,
    # and "cancel the rest of this series" is not a claim about last Tuesday.
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        db.expire_all()
        done = db.query(Job).filter(Job.recurring_schedule_id == sched.id) \
            .order_by(Job.scheduled_date).first()
        done.status = "completed"
        db.commit()
        done_id = done.id

        client.post(f"/api/recurring/{sched.id}/cancel-upcoming")
        db.expire_all()
        assert db.query(Job).get(done_id).status == "completed"
    finally:
        _cleanup(db, c, p, sched)


def test_a_visit_already_in_the_past_is_left_alone():
    # Cancelling a series says nothing about a cleaning that already happened,
    # whatever status it was left in.
    from datetime import timedelta
    from utils.dates import business_today
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        past = Job(client_id=c.id, property_id=p.id, title="Last week",
                   scheduled_date=business_today() - timedelta(days=7),
                   start_time=time(9, 0), end_time=time(12, 0),
                   status="scheduled", recurring_schedule_id=sched.id, org_id=1)
        db.add(past); db.commit(); db.refresh(past)
        past_id = past.id

        client.post(f"/api/recurring/{sched.id}/cancel-upcoming")
        db.expire_all()
        assert db.query(Job).get(past_id).status == "scheduled"
    finally:
        _cleanup(db, c, p, sched)


def test_it_keeps_the_link_to_the_series():
    # Unlike the skip path, which detaches to free the date for a re-add.
    # Nothing regenerates for a cancelled series, and the link is what lets
    # history still say which series these visits belonged to.
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        client.post(f"/api/recurring/{sched.id}/cancel-upcoming")
        db.expire_all()
        assert db.query(Job).filter(Job.recurring_schedule_id == sched.id).count() > 0
    finally:
        _cleanup(db, c, p, sched)


def test_running_it_twice_changes_nothing_the_second_time():
    # The owner will press it again when she isn't sure it worked.
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        first = client.post(f"/api/recurring/{sched.id}/cancel-upcoming").json()
        second = client.post(f"/api/recurring/{sched.id}/cancel-upcoming").json()
        assert first["cancelled_count"] > 0
        assert second["cancelled_count"] == 0
    finally:
        _cleanup(db, c, p, sched)


def test_another_orgs_series_is_not_reachable():
    # MT-3: the id is guessable, so the scope check is the only thing between
    # another tenant and a wiped calendar.
    db = SessionLocal()
    c, p, sched = _seed_series(db, org_id=99999)
    try:
        assert client.post(f"/api/recurring/{sched.id}/cancel-upcoming").status_code == 404
    finally:
        _cleanup(db, c, p, sched)


# ── The scan says so (Sept 2026) ─────────────────────────────────────────────
# Cancelling a series deliberately leaves its already-generated visits alone —
# that is R7, and `cancel-upcoming` above is the separate, explicit second act
# that removes them. What was missing is that the health check never mentioned
# the in-between state, so a board could read "29 healthy" while five cleanings
# for cancelled clients waited to be dispatched.

def test_a_cancelled_series_with_visits_still_on_the_calendar_is_flagged():
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        db.expire_all()
        live = _dates(db, sched.id, "scheduled")
        assert len(live) > 1

        assert "cancelled_with_upcoming" not in _codes(sched.id), \
            "a running series' own visits are not stranded"

        client.delete(f"/api/recurring/{sched.id}")
        codes = _codes(sched.id)
        assert "cancelled_with_upcoming" in codes

        prob = next(pr for i in _issues() if i["schedule_id"] == sched.id
                    for pr in i["problems"] if pr["code"] == "cancelled_with_upcoming")
        # The number has to be the number the button will actually remove, or
        # the confirm sentence lies about what it is about to do.
        assert prob["stranded"] == len(live)
        assert str(len(live)) in prob["message"]
        assert prob["destructive"] is True
    finally:
        _cleanup(db, c, p, sched)


def test_cancelling_those_visits_clears_the_finding():
    """The fix has to be able to clear the finding it is offered for.

    The same contract `stale_paused` had to be rewritten to keep: a health
    check that reports the same thing after you have done what it asked is
    worse than one that never mentioned it.
    """
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.post(f"/api/recurring/{sched.id}/generate")
        client.delete(f"/api/recurring/{sched.id}")
        assert "cancelled_with_upcoming" in _codes(sched.id)

        assert client.post(f"/api/recurring/{sched.id}/cancel-upcoming").status_code == 200
        assert "cancelled_with_upcoming" not in _codes(sched.id)
    finally:
        _cleanup(db, c, p, sched)


def test_a_cancelled_series_with_nothing_left_is_never_flagged():
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.delete(f"/api/recurring/{sched.id}")     # never generated anything
        assert "cancelled_with_upcoming" not in _codes(sched.id)
    finally:
        _cleanup(db, c, p, sched)


def test_an_undated_visit_raises_no_finding_the_fix_could_not_clear():
    """Sized from the set cancel-upcoming actually cancels, not from the
    looser "does this series look alive" count the rest of the scan uses.

    That count also keeps undated jobs. Sizing the finding from it would name
    a visit `cancel-upcoming` skips (it filters on scheduled_date >= today), so
    the finding would survive its own fix — and an undated row cannot be
    dispatched to, which is the whole risk this finding is about.
    """
    db = SessionLocal()
    c, p, sched = _seed_series(db)
    try:
        client.delete(f"/api/recurring/{sched.id}")
        j = Job(client_id=c.id, property_id=p.id, title="Undated",
                job_type="residential", status="scheduled",
                scheduled_date=None, recurring_schedule_id=sched.id, org_id=1)
        db.add(j); db.commit(); db.refresh(j)
        assert "cancelled_with_upcoming" not in _codes(sched.id)

        # Control: the same row WITH a date does trip it, so the assertion
        # above is about the missing date and not about some other reason the
        # series failed to qualify.
        j.scheduled_date = business_today() + timedelta(days=3)
        db.commit()
        assert "cancelled_with_upcoming" in _codes(sched.id)
    finally:
        _cleanup(db, c, p, sched)
