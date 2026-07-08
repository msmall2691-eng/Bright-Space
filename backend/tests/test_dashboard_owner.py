"""GET /api/dashboard/owner — owner KPIs (close rate, MRR, revenue by service,
AR aging, top clients).

Same delta pattern as test_dashboard_summary: snapshot → seed known rows →
assert the numbers moved by exactly that much (robust against whatever else
lives in the shared test DB).

Also unit-tests the _ar_aging_bucket helper directly since the bucket boundaries
are the kind of logic that quietly rots.
"""
import uuid
from datetime import date, datetime, timedelta, time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Property, Quote, Invoice, Job, RecurringSchedule,
)
from modules.auth.router import get_current_user, current_org_id
from modules.dashboard.router import _ar_aging_bucket


class _Admin:
    id, org_id, role, status, active = 7502, 1, "admin", "active", True
    email = "owner-admin@example.com"


@pytest.fixture
def api_client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "properties": [], "quotes": [], "jobs": [], "invoices": [], "schedules": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Invoice).filter(Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(
        RecurringSchedule.id.in_(ids["schedules"] or [0])
    ).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(ids, name=None):
    db = SessionLocal()
    c = Client(name=name or f"Owner {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    cid = c.id
    db.close()
    return cid


def _mk_property(ids, cid):
    db = SessionLocal()
    p = Property(client_id=cid, name=f"P {uuid.uuid4().hex[:6]}",
                 address="1 Owner St", property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id)
    pid = p.id
    db.close()
    return pid


def _mk_quote(ids, cid, status, total, *, sent_at=None):
    """Seed a quote. `sent_at=None` defaults to now for statuses that imply
    delivery — the close-rate query filters on sent_at, so tests need it
    populated to be counted. Pass sent_at=False to leave it NULL explicitly."""
    db = SessionLocal()
    q = Quote(client_id=cid, quote_number=f"Q-{uuid.uuid4().hex[:8]}",
              status=status, total=total, org_id=1)
    if sent_at is None and status != "draft":
        q.sent_at = datetime.utcnow()
    elif sent_at:
        q.sent_at = sent_at
    db.add(q); db.commit(); db.refresh(q)
    ids["quotes"].append(q.id)
    qid = q.id
    db.close()
    return qid


def _mk_job(ids, cid, pid, job_type="residential"):
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type=job_type,
            title="Owner test job", status="scheduled",
            scheduled_date=date.today(), org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id)
    jid = j.id
    db.close()
    return jid


def _mk_invoice(ids, cid, total, *, status, jid=None, paid_at=None, due_date=None):
    db = SessionLocal()
    inv = Invoice(client_id=cid, job_id=jid, total=total, status=status,
                  invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
                  due_date=due_date, paid_at=paid_at, org_id=1)
    db.add(inv); db.commit(); db.refresh(inv)
    ids["invoices"].append(inv.id)
    inv_id = inv.id
    db.close()
    return inv_id


def _mk_schedule(ids, cid, pid, quote_id, *, frequency="weekly", days=None, active=True):
    db = SessionLocal()
    s = RecurringSchedule(
        client_id=cid, property_id=pid, quote_id=quote_id,
        title="Owner test recurring", address="1 Owner St", job_type="residential",
        frequency=frequency, day_of_week=1, days_of_week=days,
        start_time=time(9, 0), end_time=time(11, 0),
        active=active, org_id=1,
    )
    db.add(s); db.commit(); db.refresh(s)
    ids["schedules"].append(s.id)
    sid = s.id
    db.close()
    return sid


def _snap(api):
    r = api.get("/api/dashboard/owner")
    assert r.status_code == 200, r.text
    return r.json()


# ── _ar_aging_bucket unit tests ────────────────────────────────────────────

def test_ar_aging_bucket_boundaries():
    today = date(2026, 7, 8)
    # Not yet due — returns None.
    assert _ar_aging_bucket("2026-07-08", today) is None
    assert _ar_aging_bucket("2026-07-09", today) is None
    # Just past due, 1 day and 30 days → 0_30.
    assert _ar_aging_bucket("2026-07-07", today) == "0_30"
    assert _ar_aging_bucket("2026-06-08", today) == "0_30"
    # 31–60.
    assert _ar_aging_bucket("2026-06-07", today) == "31_60"
    assert _ar_aging_bucket("2026-05-09", today) == "31_60"
    # 61–90.
    assert _ar_aging_bucket("2026-05-08", today) == "61_90"
    assert _ar_aging_bucket("2026-04-09", today) == "61_90"
    # 90+
    assert _ar_aging_bucket("2026-04-08", today) == "90_plus"


def test_ar_aging_bucket_malformed_input():
    today = date(2026, 7, 8)
    assert _ar_aging_bucket(None, today) is None
    assert _ar_aging_bucket("", today) is None
    assert _ar_aging_bucket("not-a-date", today) is None
    # Extra time suffix is tolerated (we only look at first 10 chars).
    assert _ar_aging_bucket("2026-06-08T12:00:00Z", today) == "0_30"


# ── End-to-end delta tests ──────────────────────────────────────────────────

def test_close_rate_counts_sent_and_won(api_client):
    api, ids = api_client
    before = _snap(api)["close_rate"]

    cid = _mk_client(ids)
    # 4 recent quotes: 1 converted (win), 2 sent (open), 1 declined (loss).
    _mk_quote(ids, cid, "converted", 500.0)
    _mk_quote(ids, cid, "sent", 300.0)
    _mk_quote(ids, cid, "sent", 100.0)
    _mk_quote(ids, cid, "declined", 200.0)

    after = _snap(api)["close_rate"]
    assert after["quotes_sent"] - before["quotes_sent"] == 4
    assert after["quotes_won"] - before["quotes_won"] == 1


def test_close_rate_ignores_draft(api_client):
    """Drafts haven't been sent — they don't count toward denominator."""
    api, ids = api_client
    before = _snap(api)["close_rate"]
    cid = _mk_client(ids)
    _mk_quote(ids, cid, "draft", 800.0)
    after = _snap(api)["close_rate"]
    assert after["quotes_sent"] == before["quotes_sent"]


def test_close_rate_counts_recently_sent_even_if_created_long_ago(api_client):
    """A quote drafted 120 days ago and SENT today must count in the last-90
    window — regression against the Codex-called-out bug where the filter
    was on `created_at` instead of `sent_at`."""
    api, ids = api_client
    before = _snap(api)["close_rate"]
    cid = _mk_client(ids)
    # Sent yesterday, drafted long before → belongs in the window.
    _mk_quote(ids, cid, "sent", 400.0, sent_at=datetime.utcnow() - timedelta(days=1))
    after = _snap(api)["close_rate"]
    assert after["quotes_sent"] - before["quotes_sent"] == 1


def test_close_rate_excludes_quotes_sent_before_window(api_client):
    """Symmetric: a quote sent 120 days ago must NOT count, even if it's
    still open in the pipeline today."""
    api, ids = api_client
    before = _snap(api)["close_rate"]
    cid = _mk_client(ids)
    _mk_quote(ids, cid, "sent", 400.0, sent_at=datetime.utcnow() - timedelta(days=120))
    after = _snap(api)["close_rate"]
    assert after["quotes_sent"] == before["quotes_sent"]


def test_mrr_estimate_uses_quote_total_and_frequency(api_client):
    """Weekly $250 quote → ≈ $1,083/mo (52/12 × 250). One priced schedule."""
    api, ids = api_client
    before = _snap(api)["mrr"]
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    qid = _mk_quote(ids, cid, "converted", 250.0)
    _mk_schedule(ids, cid, pid, qid, frequency="weekly")
    after = _snap(api)["mrr"]

    delta_cents = after["estimate_cents"] - before["estimate_cents"]
    expected_cents = int(round(250.0 * 52 / 12 * 100))
    assert delta_cents == expected_cents
    assert after["schedules_priced"] - before["schedules_priced"] == 1


def test_mrr_flags_unpriced_when_no_quote(api_client):
    """Active recurring schedule with no linked quote surfaces as unpriced."""
    api, ids = api_client
    before = _snap(api)["mrr"]
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    _mk_schedule(ids, cid, pid, None, frequency="weekly")
    after = _snap(api)["mrr"]
    assert after["schedules_unpriced"] - before["schedules_unpriced"] == 1
    assert after["estimate_cents"] == before["estimate_cents"]


def test_mrr_multi_day_weekly_multiplies(api_client):
    """A Mon/Wed/Fri weekly at $100 counts as 3 cleans per week (~$1,300/mo)."""
    api, ids = api_client
    before = _snap(api)["mrr"]
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    qid = _mk_quote(ids, cid, "converted", 100.0)
    _mk_schedule(ids, cid, pid, qid, frequency="weekly", days=[0, 2, 4])
    after = _snap(api)["mrr"]
    delta_cents = after["estimate_cents"] - before["estimate_cents"]
    expected = int(round(100.0 * 52 / 12 * 3 * 100))
    assert delta_cents == expected


def test_mrr_every_3_weeks_uses_interval(api_client):
    """`every_3_weeks` @ $200 → 52/12/3 = 1.44 jobs/mo ≈ $288/mo. Regression
    against the Codex bug where only weekly/biweekly/monthly were priced and
    everything else silently became `schedules_unpriced` even with a quote."""
    api, ids = api_client
    before = _snap(api)["mrr"]
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    qid = _mk_quote(ids, cid, "converted", 200.0)
    # `every_3_weeks` carries the cadence via interval_weeks=3.
    db = SessionLocal()
    s = RecurringSchedule(
        client_id=cid, property_id=pid, quote_id=qid,
        title="Every-3-weeks test", address="1 Owner St", job_type="residential",
        frequency="every_3_weeks", interval_weeks=3,
        day_of_week=1, days_of_week=None,
        start_time=time(9, 0), end_time=time(11, 0),
        active=True, org_id=1,
    )
    db.add(s); db.commit(); db.refresh(s)
    ids["schedules"].append(s.id)
    db.close()
    after = _snap(api)["mrr"]
    delta_cents = after["estimate_cents"] - before["estimate_cents"]
    expected = int(round(200.0 * (52 / 12 / 3) * 100))
    assert delta_cents == expected
    assert after["schedules_priced"] - before["schedules_priced"] == 1


def test_mrr_daily_with_weekday_filter(api_client):
    """Daily @ $50, Mon-Fri only → base 30 jobs/mo × (5/7) ≈ 21.4 jobs/mo ≈
    $1,071/mo. Confirms the daily+filter path in _monthly_job_estimate."""
    api, ids = api_client
    before = _snap(api)["mrr"]
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    qid = _mk_quote(ids, cid, "converted", 50.0)
    db = SessionLocal()
    s = RecurringSchedule(
        client_id=cid, property_id=pid, quote_id=qid,
        title="Daily M-F test", address="1 Owner St", job_type="residential",
        frequency="daily", interval_weeks=1,
        day_of_week=0, days_of_week=[0, 1, 2, 3, 4],
        start_time=time(9, 0), end_time=time(11, 0),
        active=True, org_id=1,
    )
    db.add(s); db.commit(); db.refresh(s)
    ids["schedules"].append(s.id)
    db.close()
    after = _snap(api)["mrr"]
    delta_cents = after["estimate_cents"] - before["estimate_cents"]
    expected = int(round(50.0 * (30.0 * 5 / 7) * 100))
    assert delta_cents == expected


def test_ar_aging_buckets_unpaid_by_due_date(api_client):
    """A sent invoice 5 days past due lands in 0_30; a 45-day one lands in
    31_60. Verify by delta so unrelated invoices don't confuse the math."""
    api, ids = api_client
    before = _snap(api)["ar_aging"]
    cid = _mk_client(ids)
    today = date.today()
    _mk_invoice(ids, cid, 150.0, status="sent",
                due_date=(today - timedelta(days=5)).isoformat())
    _mk_invoice(ids, cid, 300.0, status="overdue",
                due_date=(today - timedelta(days=45)).isoformat())
    # Not-yet-due invoice should NOT bucket.
    _mk_invoice(ids, cid, 500.0, status="sent",
                due_date=(today + timedelta(days=5)).isoformat())

    after = _snap(api)["ar_aging"]
    assert after["0_30"]["count"] - before["0_30"]["count"] == 1
    assert round(after["0_30"]["total"] - before["0_30"]["total"], 2) == 150.0
    assert after["31_60"]["count"] - before["31_60"]["count"] == 1
    assert round(after["31_60"]["total"] - before["31_60"]["total"], 2) == 300.0


def test_ar_aging_ignores_paid_and_draft(api_client):
    api, ids = api_client
    before = _snap(api)["ar_aging"]
    cid = _mk_client(ids)
    today = date.today()
    _mk_invoice(ids, cid, 999.0, status="paid",
                due_date=(today - timedelta(days=30)).isoformat(),
                paid_at=datetime.utcnow())
    _mk_invoice(ids, cid, 999.0, status="draft",
                due_date=(today - timedelta(days=30)).isoformat())
    after = _snap(api)["ar_aging"]
    for bucket in ("0_30", "31_60", "61_90", "90_plus"):
        assert after[bucket] == before[bucket]


def test_revenue_by_service_groups_by_job_type(api_client):
    api, ids = api_client
    before = {r["service_type"]: r["total"] for r in _snap(api)["revenue_by_service"]}
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    jid_res = _mk_job(ids, cid, pid, job_type="residential")
    jid_str = _mk_job(ids, cid, pid, job_type="str_turnover")
    now = datetime.utcnow()
    _mk_invoice(ids, cid, 400.0, status="paid", jid=jid_res, paid_at=now,
                due_date=date.today().isoformat())
    _mk_invoice(ids, cid, 900.0, status="paid", jid=jid_str, paid_at=now,
                due_date=date.today().isoformat())

    after = {r["service_type"]: r["total"] for r in _snap(api)["revenue_by_service"]}
    assert round(after.get("residential", 0.0) - before.get("residential", 0.0), 2) == 400.0
    assert round(after.get("str_turnover", 0.0) - before.get("str_turnover", 0.0), 2) == 900.0


def test_top_clients_ranks_by_paid_total(api_client):
    api, ids = api_client
    now = datetime.utcnow()
    cid_a = _mk_client(ids, name="Acme AA")
    cid_b = _mk_client(ids, name="Beta BB")
    _mk_invoice(ids, cid_a, 1000.0, status="paid", paid_at=now,
                due_date=date.today().isoformat())
    _mk_invoice(ids, cid_a, 500.0, status="paid", paid_at=now,
                due_date=date.today().isoformat())
    _mk_invoice(ids, cid_b, 300.0, status="paid", paid_at=now,
                due_date=date.today().isoformat())

    top = _snap(api)["top_clients"]
    entries = {c["client_id"]: c for c in top}
    assert entries[cid_a]["total"] == 1500.0
    assert entries[cid_a]["invoice_count"] == 2
    assert entries[cid_b]["total"] == 300.0
    # Acme outranks Beta.
    ranks = [c["client_id"] for c in top if c["client_id"] in {cid_a, cid_b}]
    assert ranks.index(cid_a) < ranks.index(cid_b)


def test_viewer_role_forbidden(api_client):
    api, ids = api_client
    class _Viewer:
        id, org_id, role, status, active = 7503, 1, "viewer", "active", True
        email = "v@example.com"
    app.dependency_overrides[get_current_user] = lambda: _Viewer()
    r = api.get("/api/dashboard/owner")
    assert r.status_code == 403
