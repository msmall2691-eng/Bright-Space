"""Home's four snapshot boxes, served inside GET /api/dashboard/board.

These boxes are read as fact by the owner at a glance, so each test pins a
number that has already been wrong somewhere else in this app: hours inflated
by an open punch, a cancelled visit counted as work, a time-off *request*
treated as approved, a dead calendar feed looking healthy, a recurring series
that stopped generating looking live.

Verified by delta where the shared test DB contributes rows of its own.
"""
import uuid
from datetime import date, datetime, time, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    CleanerTimeOff, Client, Invoice, Job, LeadIntake, Property, PropertyIcal,
    RecurringSchedule, TimeEntry, User,
)
from modules.auth.router import get_current_user, current_org_id
from services.board_snapshot import (
    _ago, _aware, _day_start_utc, _feed_state, _local_date, _TREND_WEEKS,
)
from utils.dates import business_tz, week_monday
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 7502, 1, "admin", "active", True
    email = "snapshot-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "properties": [], "jobs": [], "punches": [],
           "timeoff": [], "feeds": [], "series": [], "users": [],
           "invoices": [], "leads": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    for model, key in ((TimeEntry, "punches"), (CleanerTimeOff, "timeoff"),
                       (PropertyIcal, "feeds"), (Job, "jobs"),
                       (RecurringSchedule, "series"), (User, "users"),
                       (Invoice, "invoices"), (LeadIntake, "leads"),
                       (Property, "properties"), (Client, "clients")):
        db.query(model).filter(model.id.in_(ids[key] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _snapshot(api) -> dict:
    body = api.get("/api/dashboard/board").json()
    assert "snapshot" in body, "the board must carry Home's snapshot boxes"
    return body["snapshot"]


def _mk_client(ids):
    db = SessionLocal()
    c = Client(name=f"Snap {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def _mk_property(ids, cid):
    db = SessionLocal()
    p = Property(client_id=cid, name="8 Snapshot Way", address="8 Snapshot Way",
                 property_type="str", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id); pid = p.id; db.close()
    return pid


def _mk_job(ids, cid, pid, *, status="scheduled", cleaner_ids=None, day=None,
            job_type="residential"):
    # Default residential on purpose: a partial unique index allows only one
    # live str_turnover per property/date, and these tests seed several visits
    # on one house to check counting.
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type=job_type,
            title="Turnover", scheduled_date=day or business_today(),
            start_time=time(10, 0), end_time=time(13, 0),
            cleaner_ids=cleaner_ids or [], status=status, org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id); jid = j.id; db.close()
    return jid


def _mk_lead(ids):
    db = SessionLocal()
    li = LeadIntake(name=f"Lead {uuid.uuid4().hex[:6]}", status="new",
                    source="website", org_id=1)
    db.add(li); db.commit(); db.refresh(li)
    ids["leads"].append(li.id); db.close()


def _mk_punch(ids, cleaner_id, *, hours=None, break_minutes=0):
    """A punch that started today. hours=None leaves it open (still clocked in)."""
    db = SessionLocal()
    start = _day_start_utc(business_today()) + timedelta(hours=9)
    e = TimeEntry(cleaner_id=cleaner_id, clock_in_at=start,
                  clock_out_at=start + timedelta(hours=hours) if hours else None,
                  break_minutes=break_minutes, org_id=1)
    db.add(e); db.commit(); db.refresh(e)
    ids["punches"].append(e.id); db.close()


# ── money & hours today ──────────────────────────────────────────────────────

def test_hours_count_closed_punches_only_and_flag_who_is_still_on_the_clock(client):
    """An open punch has no duration yet. Adding elapsed time for someone who
    forgot to clock out would silently inflate today's labour every hour they
    stay logged in — the number the owner reads to decide if a day went well."""
    api, ids = client
    before = _snapshot(api)["money_today"]

    cid = f"snap-{uuid.uuid4().hex[:6]}"
    _mk_punch(ids, cid, hours=3, break_minutes=30)   # 3h worked, 30m break → 2.5h
    _mk_punch(ids, f"{cid}-b")                       # still on the clock

    after = _snapshot(api)["money_today"]
    assert round(after["hours"] - before["hours"], 2) == 2.5
    assert after["on_clock"] - before["on_clock"] == 1
    assert after["hours_label"].endswith("h")


def test_cancelled_visits_are_not_part_of_todays_visit_count(client):
    """"3 of 5 done" has to mean five visits that are actually happening."""
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    before = _snapshot(api)["money_today"]

    _mk_job(ids, cid, pid, status="completed")
    _mk_job(ids, cid, pid, status="cancelled")

    after = _snapshot(api)["money_today"]
    assert after["visits_total"] - before["visits_total"] == 1
    assert after["visits_done"] - before["visits_done"] == 1


def test_money_in_and_money_billed_are_separate_numbers(client):
    """Collected (cash in) and invoiced (asked for) are different questions.
    The snapshot passes collected through from the board's own stat tile so
    the box and the tile can never disagree; invoiced is its own read, and a
    draft invoice — sent to nobody — must not count as billed."""
    api, ids = client
    cid = _mk_client(ids)
    before = _snapshot(api)["money_today"]

    db = SessionLocal()
    paid = Invoice(client_id=cid, invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
                   status="paid", total=180.0,
                   paid_at=_day_start_utc(business_today()) + timedelta(hours=2),
                   org_id=1)
    draft = Invoice(client_id=cid, invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
                    status="draft", total=999.0, org_id=1)
    db.add_all([paid, draft]); db.commit()
    db.refresh(paid); db.refresh(draft)
    ids["invoices"] += [paid.id, draft.id]
    db.close()

    after = _snapshot(api)["money_today"]
    assert round(after["collected"] - before["collected"], 2) == 180.0
    assert round(after["invoiced"] - before["invoiced"], 2) == 180.0, \
        "the paid invoice was billed too; the $999 draft was not"


# ── crew today ───────────────────────────────────────────────────────────────

def test_only_approved_time_off_takes_someone_off_the_day(client):
    """A crew-submitted request is a decision the owner still owes. Counting
    it as time off would quietly remove a cleaner the office is still
    planning to schedule (migration 089)."""
    api, ids = client
    today = business_today()
    before = _snapshot(api)["crew"]

    db = SessionLocal()
    approved = CleanerTimeOff(cleaner_id=f"off-{uuid.uuid4().hex[:6]}",
                              cleaner_name="Approved Amy", start_date=today,
                              end_date=today, reason="vacation",
                              status="approved", org_id=1)
    requested = CleanerTimeOff(cleaner_id=f"req-{uuid.uuid4().hex[:6]}",
                               cleaner_name="Pending Pat", start_date=today,
                               end_date=today + timedelta(days=2), reason="sick",
                               status="requested", org_id=1)
    db.add_all([approved, requested]); db.commit()
    db.refresh(approved); db.refresh(requested)
    ids["timeoff"] += [approved.id, requested.id]
    db.close()

    after = _snapshot(api)["crew"]
    assert after["off_total"] - before["off_total"] == 1
    assert after["pending_requests"] - before["pending_requests"] == 1
    names = [r["name"] for r in after["off"]]
    assert "Approved Amy" in names
    assert "Pending Pat" not in names


def test_working_list_counts_each_cleaners_jobs_and_unassigned_work(client):
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    crew = f"work-{uuid.uuid4().hex[:6]}"
    before = _snapshot(api)["crew"]

    _mk_job(ids, cid, pid, cleaner_ids=[crew], status="completed")
    _mk_job(ids, cid, pid, cleaner_ids=[crew])
    _mk_job(ids, cid, pid, cleaner_ids=[])          # nobody on it

    after = _snapshot(api)["crew"]
    row = next(r for r in after["working"] if r["cleaner_id"] == crew)
    assert row["jobs"] == 2 and row["done"] == 1
    assert after["unassigned_today"] - before["unassigned_today"] == 1


def test_a_claimed_crew_id_shows_the_persons_name(client):
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    crew = f"named-{uuid.uuid4().hex[:6]}"

    db = SessionLocal()
    u = User(email=f"{crew}@example.com", full_name="Dana Cleaner",
             role="cleaner", cleaner_id=crew, org_id=1)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id); db.close()

    _mk_job(ids, cid, pid, cleaner_ids=[crew])

    row = next(r for r in _snapshot(api)["crew"]["working"] if r["cleaner_id"] == crew)
    assert row["name"] == "Dana Cleaner"


# ── turnover feed health ─────────────────────────────────────────────────────

def _mk_feed(ids, pid, *, status="ok", synced_hours_ago=0.1, error=None):
    db = SessionLocal()
    f = PropertyIcal(property_id=pid, url=f"https://example.com/{uuid.uuid4().hex}.ics",
                     source="airbnb", active=True,
                     last_sync_status=status,
                     last_synced_at=(datetime.now(timezone.utc).replace(tzinfo=None)
                                     - timedelta(hours=synced_hours_ago))
                     if synced_hours_ago is not None else None,
                     last_sync_error=error, org_id=1)
    db.add(f); db.commit(); db.refresh(f)
    ids["feeds"].append(f.id); fid = f.id; db.close()
    return fid


def test_a_healthy_feed_is_counted_but_never_listed_as_a_problem(client):
    """The box is a problem list. A feed that synced ten minutes ago is
    background noise — it belongs in the "N feeds OK" count, nowhere else."""
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    before = _snapshot(api)["feeds"]

    fid = _mk_feed(ids, pid, status="ok", synced_hours_ago=0.2)

    after = _snapshot(api)["feeds"]
    assert after["total"] - before["total"] == 1
    assert after["ok"] - before["ok"] == 1
    assert fid not in [p["id"] for p in after["problems"]]


def test_a_dead_feed_surfaces_with_the_house_it_belongs_to(client):
    """A turnover job only exists because a feed reported a checkout. A feed
    that stopped looks exactly like a quiet week on the schedule, so this is
    the only place the failure is visible."""
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)

    stale = _mk_feed(ids, pid, status="ok", synced_hours_ago=48)
    failed = _mk_feed(ids, pid, status="failed", synced_hours_ago=1,
                      error="403 Forbidden from Airbnb")
    never = _mk_feed(ids, pid, status=None, synced_hours_ago=None)

    feeds = _snapshot(api)["feeds"]
    by_id = {p["id"]: p for p in feeds["problems"]}
    assert by_id[failed]["state"] == "failing"
    assert "403" in by_id[failed]["detail"]
    assert by_id[stale]["state"] == "stale"
    assert by_id[never]["state"] == "never"
    # Every problem names the house, so the owner knows whose bookings stopped.
    assert by_id[failed]["property_name"] == "8 Snapshot Way"


# ── recurring series that stopped generating ─────────────────────────────────

def test_an_active_series_with_nothing_upcoming_is_reported_as_stalled(client):
    """This is the silent failure: the series still says "active", the client
    still expects visits, and nothing is on the calendar."""
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)

    db = SessionLocal()
    s = RecurringSchedule(client_id=cid, property_id=pid, job_type="residential",
                          title="Weekly kitchen + baths", address="8 Snapshot Way",
                          frequency="weekly", interval_weeks=1, day_of_week=2,
                          start_time=time(9, 0), end_time=time(12, 0),
                          active=True, org_id=1)
    db.add(s); db.commit(); db.refresh(s)
    ids["series"].append(s.id); sid = s.id; db.close()

    rec = _snapshot(api)["recurring"]
    row = next((r for r in rec["stalled"] if r["schedule_id"] == sid), None)
    assert row is not None, "an active series with no upcoming visits must be flagged"
    assert row["code"] == "active_no_upcoming"
    assert row["title"] == "Weekly kitchen + baths"
    assert rec["scanned"] >= 1


def test_a_series_that_is_generating_visits_is_not_flagged(client):
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)

    db = SessionLocal()
    s = RecurringSchedule(client_id=cid, property_id=pid, job_type="residential",
                          title="Biweekly whole house", address="8 Snapshot Way",
                          frequency="biweekly", interval_weeks=2, day_of_week=1,
                          start_time=time(9, 0), end_time=time(12, 0),
                          active=True, org_id=1)
    db.add(s); db.commit(); db.refresh(s)
    ids["series"].append(s.id); sid = s.id; db.close()

    # A real upcoming visit from that series.
    jid = _mk_job(ids, cid, pid, day=business_today() + timedelta(days=3))
    db = SessionLocal()
    db.query(Job).filter(Job.id == jid).update({"recurring_schedule_id": sid})
    db.commit(); db.close()

    rec = _snapshot(api)["recurring"]
    assert sid not in [r["schedule_id"] for r in rec["stalled"]]


# ── failure isolation ────────────────────────────────────────────────────────

def test_a_broken_box_never_takes_down_the_board(monkeypatch, client):
    """The snapshot is a nicety on top of the attention board. If one box
    raises, the board — the thing the owner actually needs — must still
    render, with that box simply absent."""
    api, _ = client
    import services.board_snapshot as bs
    monkeypatch.setattr(bs, "_feed_health", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    body = api.get("/api/dashboard/board").json()
    assert body["snapshot"]["feeds"] is None
    assert body["snapshot"]["crew"] is not None
    assert body["sections"], "the board itself must still be there"


def test_timestamps_normalize_before_any_arithmetic():
    """Feed syncs stamp `datetime.now(timezone.utc)` into a naive DateTime
    column, so the value comes back naive on one backend and aware on another.
    Subtracting one from the other raises — and inside a failure-isolated box
    that would blank the very widget whose job is reporting the outage."""
    naive = datetime(2026, 8, 21, 12, 0)
    aware = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)
    now = datetime(2026, 8, 21, 18, 0, tzinfo=timezone.utc)

    assert _aware(naive) == aware
    assert _aware(aware) == aware
    assert _aware(None) is None
    # Both shapes must reach the same answer, and neither may raise.
    assert _ago(_aware(naive), now) == _ago(_aware(aware), now) == "6h ago"


def test_a_feed_verdict_is_the_same_whether_the_stamp_is_naive_or_aware():
    """ical_sync stamps `datetime.now(timezone.utc)` into a naive DateTime
    column, so the value round-trips naive on SQLite and aware on Postgres.
    The verdict — and the "2d ago" it prints — must not depend on which.

    Asserted against the pure helper rather than through the endpoint on
    purpose: SQLite hands back a naive value either way, so an end-to-end
    version of this test would pass without ever exercising the aware path.
    """
    now = datetime(2026, 8, 21, 18, 0, tzinfo=timezone.utc)
    cutoff = now - timedelta(hours=6)
    naive = datetime(2026, 8, 19, 18, 0)
    aware = naive.replace(tzinfo=timezone.utc)

    assert _feed_state("ok", naive, None, now=now, cutoff=cutoff) == \
           _feed_state("ok", aware, None, now=now, cutoff=cutoff) == ("stale", "Last synced 2d ago")


def test_a_failing_feed_outranks_a_merely_stale_one():
    """A 403 from Airbnb needs a human today; a feed that's a few hours behind
    usually fixes itself on the next tick. The error text is what's shown."""
    now = datetime(2026, 8, 21, 18, 0, tzinfo=timezone.utc)
    cutoff = now - timedelta(hours=6)

    # Status wins over recency: a feed that failed one minute ago is failing,
    # not "ok because it synced recently".
    state, detail = _feed_state("failed", now - timedelta(minutes=1),
                                "403 Forbidden from Airbnb", now=now, cutoff=cutoff)
    assert state == "failing"
    assert detail == "403 Forbidden from Airbnb"

    assert _feed_state("ok", now - timedelta(minutes=5), None,
                       now=now, cutoff=cutoff) == ("ok", "")
    assert _feed_state(None, None, None, now=now, cutoff=cutoff)[0] == "never"


def test_home_and_sync_agree_on_when_a_feed_is_stale():
    """Home's box and /sync (plus the property pages and the Owner Dashboard's
    feed tile) read the same feeds. If the thresholds drift, one screen calls a
    feed dead while another calls it healthy, and the owner can't tell which to
    believe."""
    from modules.properties.router import _ICAL_STALE_AFTER
    from services.board_snapshot import _STALE_FEED_HOURS
    assert _STALE_FEED_HOURS == _ICAL_STALE_AFTER.total_seconds() / 3600


def test_day_start_helper_is_business_local_not_utc_midnight():
    """Maine is UTC-4/-5, so UTC midnight is still yesterday evening locally.
    Using it would fold a chunk of yesterday's punches into today's hours."""
    d = date(2026, 8, 21)
    start = _day_start_utc(d)
    assert start.tzinfo is None
    assert start.date() in (d, d - timedelta(days=1))
    assert start != datetime(2026, 8, 21, 0, 0)


# ── money over time ──────────────────────────────────────────────────────────

def test_money_trend_covers_whole_weeks_up_to_this_one(client):
    api, _ = client
    trend = _snapshot(api)["money_trend"]

    assert len(trend["points"]) == _TREND_WEEKS
    weeks = [date.fromisoformat(p["week"]) for p in trend["points"]]
    assert all(w.weekday() == 0 for w in weeks), "every bucket starts on a Monday"
    assert weeks == sorted(weeks) and weeks[-1] == week_monday(business_today())
    # Consecutive, no gaps.
    assert all((b - a).days == 7 for a, b in zip(weeks, weeks[1:]))


def test_a_payment_lands_in_the_week_it_was_actually_made(client):
    """Bucketing by UTC date would push an evening payment into the next day —
    and on a Sunday, into the next WEEK, making one week look better than it
    was and the next look worse."""
    api, ids = client
    cid = _mk_client(ids)
    before = _snapshot(api)["money_trend"]

    # 9pm local on the most recent Sunday: still last week locally, already
    # Monday in UTC.
    this_monday = week_monday(business_today())
    sunday = this_monday - timedelta(days=1)
    local_9pm = datetime.combine(sunday, time(21, 0), tzinfo=business_tz())
    paid_at = local_9pm.astimezone(timezone.utc).replace(tzinfo=None)
    assert _local_date(paid_at) == sunday, "the helper must read it as Sunday"

    db = SessionLocal()
    inv = Invoice(client_id=cid, invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
                  status="paid", total=300.0, paid_at=paid_at, org_id=1)
    db.add(inv); db.commit(); db.refresh(inv)
    ids["invoices"].append(inv.id); db.close()

    after = _snapshot(api)["money_trend"]
    by_week = {p["week"]: p for p in after["points"]}
    prior = {p["week"]: p for p in before["points"]}
    last_week = (this_monday - timedelta(days=7)).isoformat()

    assert round(by_week[last_week]["collected"] - prior[last_week]["collected"], 2) == 300.0
    assert round(by_week[this_monday.isoformat()]["collected"]
                 - prior[this_monday.isoformat()]["collected"], 2) == 0.0


def test_collected_and_invoiced_are_tracked_separately(client):
    """Work billed one week is often paid the next; the gap between the two
    lines is the whole reason to chart them together."""
    api, ids = client
    cid = _mk_client(ids)
    before = _snapshot(api)["money_trend"]

    db = SessionLocal()
    sent = Invoice(client_id=cid, invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
                   status="sent", total=500.0, org_id=1)
    db.add(sent); db.commit(); db.refresh(sent)
    ids["invoices"].append(sent.id); db.close()

    after = _snapshot(api)["money_trend"]
    assert round(after["invoiced_total"] - before["invoiced_total"], 2) == 500.0
    assert round(after["collected_total"] - before["collected_total"], 2) == 0.0
    assert after["has_data"] is True


# ── lead drop-off ────────────────────────────────────────────────────────────

def test_home_funnel_and_the_funnel_page_report_the_same_cohort(client):
    """Home's chart and /api/dashboard/funnel call one function on purpose.
    If these ever disagree, one screen is lying about how sales are going."""
    api, ids = client
    _mk_lead(ids)

    snap = _snapshot(api)["lead_funnel"]
    page = api.get(f"/api/dashboard/funnel?days={snap['window_days']}").json()
    page_counts = {s["key"]: s["count"] for s in page["funnel"]}

    assert [s["key"] for s in snap["steps"]] == ["requests", "quoted", "accepted", "won"]
    for step in snap["steps"]:
        assert step["count"] == page_counts[step["key"]], step["key"]
    assert snap["overall_pct"] == page["conversion"]["overall_pct"]


def test_funnel_bar_widths_are_shares_of_the_first_stage(client):
    api, ids = client
    _mk_lead(ids)

    snap = _snapshot(api)["lead_funnel"]
    assert snap["has_data"] is True
    assert snap["widths"][0] == 100
    # Monotonically narrowing: a later stage can never be wider than an earlier.
    assert snap["widths"] == sorted(snap["widths"], reverse=True)
    assert all(0 <= w <= 100 for w in snap["widths"])
