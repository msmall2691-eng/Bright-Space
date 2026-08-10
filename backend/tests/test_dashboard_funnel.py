"""GET /api/dashboard/funnel — the intake→quote conversion funnel.

Cohort by request (LeadIntake) in the window; each request is followed to its
linked quote's furthest stage. Endpoint assertions are delta-based (snapshot,
seed known rows, assert the movement) so they're robust against whatever else
lives in the shared test DB — the same approach test_dashboard_summary uses.
Per-source numbers use a unique source string so they can be asserted exactly.
The stage/median/tz helpers are pure and unit-tested directly.
"""
import uuid
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote, LeadIntake
from modules.auth.router import get_current_user, current_org_id
from modules.dashboard.router import _quote_stage, _median, _as_naive_utc


# ── Pure helpers ────────────────────────────────────────────────────────────

def _q(status, **ts):
    base = dict(sent_at=None, follow_up_sent_at=None, viewed_at=None,
                accepted_at=None, converted_at=None)
    base.update(ts)
    return SimpleNamespace(status=status, **base)


def test_quote_stage_from_status_alone():
    assert _quote_stage(_q("draft")) == 0
    assert _quote_stage(_q("sent")) == 1
    assert _quote_stage(_q("viewed")) == 2
    assert _quote_stage(_q("changes_requested")) == 2   # seen it to ask for changes
    assert _quote_stage(_q("accepted")) == 3
    assert _quote_stage(_q("converted")) == 4
    assert _quote_stage(_q("declined")) == 1            # declined after being sent
    assert _quote_stage(_q("expired")) == 1


def test_quote_stage_is_monotonic_from_timestamps():
    now = datetime.now(timezone.utc)
    # An admin phone-accept: accepted with no recorded view must still rank
    # above 'viewed' (the funnel can't go backwards).
    assert _quote_stage(_q("accepted", accepted_at=now)) == 3
    assert _quote_stage(_q("draft", sent_at=now)) == 1
    assert _quote_stage(_q("draft", converted_at=now)) == 4


def test_median():
    assert _median([]) is None
    assert _median([5]) == 5
    assert _median([1, 2, 3]) == 2
    assert _median([1, 2, 3, 4]) == 2.5
    assert _median([3, 1, 2, None]) == 2   # Nones dropped, then sorted


def test_as_naive_utc_flattens_aware_and_parses_strings():
    aware = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
    out = _as_naive_utc(aware)
    assert out.tzinfo is None and out.hour == 12
    # A naive value passes through; an aware minus a naive would otherwise raise.
    naive = datetime(2026, 7, 1, 10, 0)
    assert (_as_naive_utc(aware) - _as_naive_utc(naive)).total_seconds() == 2 * 3600
    assert _as_naive_utc("2026-07-01T09:00:00").hour == 9
    assert _as_naive_utc(None) is None
    assert _as_naive_utc("not-a-date") is None


# ── Endpoint (delta-based) ──────────────────────────────────────────────────

class _Admin:
    id, org_id, role, status, active = 7421, 1, "admin", "active", True
    email = "funnel-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    ids = {"clients": [], "quotes": [], "leads": []}
    yield c, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(LeadIntake).filter(LeadIntake.id.in_(ids["leads"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _client(ids):
    db = SessionLocal()
    c = Client(name=f"Funnel {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def _request(ids, cid, source, *, quote_status=None, total=100.0,
             sent=False, viewed=False, accepted=False, converted=False,
             intake_age_days=0):
    """Seed a LeadIntake and (optionally) its linked Quote at a given stage."""
    db = SessionLocal()
    now = datetime.now(timezone.utc)
    quote_id = None
    if quote_status is not None:
        q = Quote(
            client_id=cid, quote_number=f"Q-{uuid.uuid4().hex[:8]}", status=quote_status,
            total=total, org_id=1,
            sent_at=now if sent else None,
            viewed_at=now if viewed else None,
            accepted_at=now if accepted else None,
            converted_at=now if converted else None,
        )
        db.add(q); db.commit(); db.refresh(q)
        ids["quotes"].append(q.id); quote_id = q.id
    li = LeadIntake(
        name=f"Lead {uuid.uuid4().hex[:6]}", source=source, org_id=1,
        status="quoted" if quote_id else "new", converted_quote_id=quote_id,
    )
    db.add(li); db.commit(); db.refresh(li)
    # The request always precedes its quote in real life; stamp it an hour
    # before "now" (and intake_age_days back) so time-to-quote is positive.
    li.created_at = datetime.utcnow() - timedelta(days=intake_age_days, hours=1)
    db.commit()
    ids["leads"].append(li.id); db.close()


def _stage(funnel, key):
    return next(s["count"] for s in funnel if s["key"] == key)


def test_funnel_cohort_counts_conversion_and_source(api):
    c, ids = api
    src = f"funneltest-{uuid.uuid4().hex[:8]}"      # unique → by_source is exact
    before = c.get("/api/dashboard/funnel?days=90").json()
    b = {s["key"]: s["count"] for s in before["funnel"]}

    cid = _client(ids)
    _request(ids, cid, src)                                                   # not quoted
    _request(ids, cid, src, quote_status="draft")                            # quoted, stage 0
    _request(ids, cid, src, quote_status="sent", sent=True)                  # stage 1
    _request(ids, cid, src, quote_status="viewed", sent=True, viewed=True)   # stage 2
    _request(ids, cid, src, quote_status="accepted", sent=True, viewed=True, accepted=True)  # stage 3
    _request(ids, cid, src, quote_status="converted", sent=True, viewed=True, accepted=True, converted=True)  # stage 4
    _request(ids, cid, src, quote_status="changes_requested")               # stage 2, outcome changes
    _request(ids, cid, src, quote_status="declined")                        # stage 1, outcome declined

    after = c.get("/api/dashboard/funnel?days=90").json()
    a = {s["key"]: s["count"] for s in after["funnel"]}

    assert a["requests"] - b["requests"] == 8
    assert a["quoted"] - b["quoted"] == 7
    assert a["sent"] - b["sent"] == 6      # all but the draft
    assert a["viewed"] - b["viewed"] == 4  # viewed, accepted, converted, changes_requested
    assert a["accepted"] - b["accepted"] == 2
    assert a["won"] - b["won"] == 1

    # Funnel is monotonic (a cohort can only shrink as it flows down).
    counts = [s["count"] for s in after["funnel"]]
    assert counts == sorted(counts, reverse=True)

    # Per-source row is exact (unique source string isolates this test's rows).
    row = next(r for r in after["by_source"] if r["source"] == src)
    assert row == {"source": src, "requests": 8, "quoted": 7, "won": 1, "won_pct": 12.5}

    # Money stages: 7 quoted × $100, 2 accepted, 1 won (deltas).
    assert round(after["value"]["quoted"] - before["value"]["quoted"], 2) == 700.0
    assert round(after["value"]["accepted"] - before["value"]["accepted"], 2) == 200.0
    assert round(after["value"]["won"] - before["value"]["won"], 2) == 100.0

    # Outcome mix deltas (current status of each quoted request).
    ob, oa = before["outcomes"], after["outcomes"]
    assert oa["won"] - ob["won"] == 1
    assert oa["accepted"] - ob["accepted"] == 1
    assert oa["declined"] - ob["declined"] == 1
    assert oa["changes_requested"] - ob["changes_requested"] == 1
    assert oa["open"] - ob["open"] == 3   # draft + sent + viewed still in play

    # Conversion + timing shape present and sane.
    assert 0 <= after["conversion"]["overall_pct"] <= 100
    assert after["timing"]["quoted_sample"] >= 7
    assert isinstance(after["window_days"], int) and after["window_days"] == 90


def test_funnel_window_excludes_older_requests(api):
    c, ids = api
    src = f"funnelwin-{uuid.uuid4().hex[:8]}"
    cid = _client(ids)
    b30 = c.get("/api/dashboard/funnel?days=30").json()
    b90 = c.get("/api/dashboard/funnel?days=90").json()
    r30_before = _stage(b30["funnel"], "requests")
    r90_before = _stage(b90["funnel"], "requests")

    # A request from 60 days ago: outside the 30-day window, inside the 90.
    _request(ids, cid, src, quote_status="sent", sent=True, intake_age_days=60)

    a30 = c.get("/api/dashboard/funnel?days=30").json()
    a90 = c.get("/api/dashboard/funnel?days=90").json()
    assert _stage(a30["funnel"], "requests") - r30_before == 0
    assert _stage(a90["funnel"], "requests") - r90_before == 1
