"""Deterministic AI follow-up scans + quick-bar record context.

CI has no ANTHROPIC_API_KEY, so everything here exercises the deterministic
paths: _compute_followups is pure DB reads and _build_record_context is plain
string building. The guarantees that matter:

  1. The turnover-gap scan fires when a guest checkout has no turnover job and
     clears once one exists (shared with scheduler.turnover_coverage_tick via
     services/turnover_coverage.py — same definition of "covered").
  2. The unbilled-jobs scan follows the real Invoice.job_id linkage — linking
     an invoice to the job removes it from the count.
  3. Record context is tenant-isolated (another org's record reads as
     nonexistent) and a property block NEVER carries access details
     (house code, lockbox notes, wifi credentials) even when they're set.
"""
from datetime import date, datetime, time, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, ICalEvent, Invoice, Job, Org, Property, PropertyIcal, Quote, User,
)
from modules.auth.router import current_org_id, get_current_user
import modules.ai.router as ai_router
from modules.ai.router import _build_record_context, _compute_followups
from services.turnover_coverage import compute_turnover_coverage


class _Admin:
    id, org_id, role, status, active = 7701, 1, "admin", "active", True
    email = "ai-followups-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _cleanup(db, *, client_ids=(), property_ids=(), quote_ids=()):
    """Shared-DB hygiene: remove exactly what a test seeded (FK-safe order)."""
    if property_ids:
        db.query(Invoice).filter(Invoice.job_id.in_(
            [j.id for j in db.query(Job).filter(Job.property_id.in_(property_ids))]
        )).delete(synchronize_session=False)
        db.query(Job).filter(Job.property_id.in_(property_ids)).delete(synchronize_session=False)
        db.query(ICalEvent).filter(ICalEvent.property_id.in_(property_ids)).delete(synchronize_session=False)
        db.query(PropertyIcal).filter(PropertyIcal.property_id.in_(property_ids)).delete(synchronize_session=False)
        db.query(Property).filter(Property.id.in_(property_ids)).delete(synchronize_session=False)
    if quote_ids:
        db.query(Quote).filter(Quote.id.in_(quote_ids)).delete(synchronize_session=False)
    if client_ids:
        db.query(Invoice).filter(Invoice.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(Client).filter(Client.id.in_(client_ids)).delete(synchronize_session=False)
    db.commit()


def _ensure_org2(db):
    if not db.query(Org).filter(Org.id == 2).first():
        db.add(Org(id=2, name="Other Cleaning Co", slug="other-cleaning-co"))
        db.commit()


def test_turnover_gap_scan_fires_and_clears_when_covered():
    db = SessionLocal()
    c = p = None
    try:
        c = Client(name="Gap Owner", email="gap@example.com", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="Gap Cottage", address="1 Gap Rd",
                     property_type="str", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        # Healthy feed: this test is about the coverage gap, not feed health.
        db.add(PropertyIcal(property_id=p.id, url="https://example.com/gap.ics",
                            source="airbnb", active=True, org_id=1,
                            last_sync_status="ok",
                            last_synced_at=datetime.now(timezone.utc)))
        checkout = date.today() + timedelta(days=5)
        db.add(ICalEvent(property_id=p.id, uid="gap-1@feed", summary="Reserved",
                         event_type="reservation", org_id=1,
                         checkout_date=checkout.isoformat(),
                         checkin_date=(checkout - timedelta(days=2)).isoformat()))
        db.commit()

        # Uncovered: the shared helper flags this property/date...
        cov = compute_turnover_coverage(db, org_id=1)
        mine = next((f for f in cov["flagged"] if f["property_id"] == p.id), None)
        assert mine is not None and checkout.isoformat() in mine["missing"]

        # ...and the follow-up scan surfaces it, high severity, actionable href.
        res = _compute_followups(db, 1)
        item = next((i for i in res["followups"] if "checkout" in i["title"]), None)
        assert item is not None, "expected a guest-checkout gap follow-up"
        assert item["severity"] == "high"
        assert item["href"] == "/schedule"

        # Covered: adding the turnover clears this property from the scan.
        db.add(Job(client_id=c.id, property_id=p.id, org_id=1,
                   job_type="str_turnover", title="Turnover",
                   scheduled_date=checkout, start_time=time(10, 0),
                   end_time=time(13, 0), status="scheduled"))
        db.commit()
        cov2 = compute_turnover_coverage(db, org_id=1)
        assert next((f for f in cov2["flagged"] if f["property_id"] == p.id),
                    None) is None, "covered checkout must not be flagged"
    finally:
        db.rollback()
        _cleanup(db, client_ids=[c.id] if c else (),
                 property_ids=[p.id] if p else ())
        db.close()


def test_unbilled_jobs_scan_follows_invoice_job_linkage():
    db = SessionLocal()
    c = p = None
    try:
        c = Client(name="Unbilled Owner", email="unbilled@example.com",
                   status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="Unbilled House", address="2 Bill Rd",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        j = Job(client_id=c.id, property_id=p.id, org_id=1,
                job_type="residential", title="Deep clean",
                scheduled_date=date.today() - timedelta(days=10),
                status="completed")
        db.add(j); db.commit(); db.refresh(j)

        def unbilled_count():
            res = _compute_followups(db, 1)
            item = next((i for i in res["followups"]
                         if "never invoiced" in i["title"]), None)
            return int(item["title"].split()[0]) if item else 0

        n_before = unbilled_count()
        assert n_before >= 1, "completed job with no invoice must be flagged"

        # Linking an invoice BY job_id (the linkage auto_create_draft_invoice
        # uses) is what clears it — a client-only invoice would not.
        db.add(Invoice(client_id=c.id, job_id=j.id, org_id=1,
                       status="draft", total=150.0))
        db.commit()
        assert unbilled_count() == n_before - 1
    finally:
        db.rollback()
        _cleanup(db, client_ids=[c.id] if c else (),
                 property_ids=[p.id] if p else ())
        db.close()


def test_record_context_is_tenant_isolated():
    db = SessionLocal()
    other = mine = None
    try:
        _ensure_org2(db)
        other = Client(name="Rival Tenant Client", status="active", org_id=2)
        mine = Client(name="Casey Context", status="active", org_id=1,
                      phone="+12075550100", email="casey@example.com")
        db.add_all([other, mine]); db.commit()
        db.refresh(other); db.refresh(mine)

        # Another org's record and a nonexistent one look identical: None.
        assert _build_record_context(db, 1, "client", other.id) is None
        assert _build_record_context(db, 1, "client", 99999999) is None

        txt = _build_record_context(db, 1, "client", mine.id)
        assert txt is not None and "Casey Context" in txt
    finally:
        db.rollback()
        _cleanup(db, client_ids=[x.id for x in (other, mine) if x])
        db.close()


def test_property_record_context_never_carries_access_details():
    db = SessionLocal()
    c = p = None
    try:
        c = Client(name="Access Owner", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="Context Cottage", address="3 Ctx Ln",
                     city="Portland", state="ME", property_type="str",
                     active=True, org_id=1,
                     access_notes="Side door, lockbox 4251",
                     house_code="9999#", wifi_ssid="CottageNet",
                     wifi_password="hunter2-secret")
        db.add(p); db.commit(); db.refresh(p)

        txt = _build_record_context(db, 1, "property", p.id)
        assert txt is not None and "Context Cottage" in txt
        # Crown jewels: none of the access/credential field values may reach
        # an AI prompt, even when populated.
        for secret in ("4251", "lockbox", "9999#", "CottageNet",
                       "hunter2-secret", "Side door"):
            assert secret not in txt, f"access detail {secret!r} leaked into prompt context"
        # Cross-org read of the same property is also invisible.
        _ensure_org2(db)
        assert _build_record_context(db, 2, "property", p.id) is None
    finally:
        db.rollback()
        _cleanup(db, client_ids=[c.id] if c else (),
                 property_ids=[p.id] if p else ())
        db.close()


def test_draft_quote_followup_fallback_and_org_scope(api):
    db = SessionLocal()
    c = other_c = None
    q_ids = []
    try:
        _ensure_org2(db)
        c = Client(name="Quote Nudge", email="nudge@example.com",
                   status="active", org_id=1)
        other_c = Client(name="Quote Rival", status="active", org_id=2)
        db.add_all([c, other_c]); db.commit()
        db.refresh(c); db.refresh(other_c)
        q = Quote(client_id=c.id, org_id=1, quote_number="Q-AIFU-1",
                  status="sent", total=250.0,
                  sent_at=datetime.now(timezone.utc) - timedelta(days=5))
        q2 = Quote(client_id=other_c.id, org_id=2, quote_number="Q-AIFU-2",
                   status="sent", total=99.0)
        db.add_all([q, q2]); db.commit()
        q_ids = [q.id, q2.id]

        # No ANTHROPIC_API_KEY → deterministic fallback, SMS shape by default.
        r = api.post(f"/api/ai/draft-quote-followup/{q.id}", json={})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("message") and "Q-AIFU-1" in body["message"]
        assert "$250.00" in body["message"]
        assert body.get("subject") == ""          # SMS: no subject
        assert not body.get("error")

        # Another tenant's quote: same envelope as nonexistent (no leak).
        r2 = api.post(f"/api/ai/draft-quote-followup/{q2.id}", json={})
        assert r2.status_code == 200
        assert r2.json().get("error") == "Quote not found"
    finally:
        db.rollback()
        _cleanup(db, client_ids=[x.id for x in (c, other_c) if x],
                 quote_ids=q_ids)
        db.close()


def test_draft_review_request_completed_only(api):
    db = SessionLocal()
    c = p = None
    try:
        c = Client(name="Review Client", email="review@example.com",
                   status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="Review House", address="4 Rev Rd",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        done = Job(client_id=c.id, property_id=p.id, org_id=1,
                   job_type="residential", title="Standard clean",
                   scheduled_date=date.today() - timedelta(days=1),
                   status="completed")
        pending = Job(client_id=c.id, property_id=p.id, org_id=1,
                      job_type="residential", title="Upcoming clean",
                      scheduled_date=date.today() + timedelta(days=3),
                      status="scheduled")
        db.add_all([done, pending]); db.commit()
        db.refresh(done); db.refresh(pending)

        r = api.post(f"/api/ai/draft-review-request/{done.id}", json={})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("message") and "Review" in body["message"]  # first name
        assert str(done.scheduled_date) in body["message"]          # service date
        assert not body.get("error")

        # A job that hasn't happened can't be review-requested.
        r2 = api.post(f"/api/ai/draft-review-request/{pending.id}", json={})
        assert r2.status_code == 200
        assert r2.json().get("error")
    finally:
        db.rollback()
        _cleanup(db, client_ids=[c.id] if c else (),
                 property_ids=[p.id] if p else ())
        db.close()


# ── POST /api/ai/draft-crew-message/{user_id} ───────────────────────────────
# Autopilot Phase 4. CI has no ANTHROPIC_API_KEY, so these exercise the
# deterministic fallback — which renders the same lineup facts the prompt
# would get, so the no-access-details guarantee holds for both paths.

def _seed_cleaner(db, *, email, cleaner_id="C-DAYPLAN", org_id=1):
    u = User(email=email, role="cleaner", full_name="Dana Cleaner",
             cleaner_id=cleaner_id, org_id=org_id, active=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cleanup_users(db, user_ids):
    if user_ids:
        db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        db.commit()


def test_draft_crew_message_lineup_never_leaks_access_details(api):
    """Fallback draft carries the cleaner's lineup (client name + time, own
    jobs only) and NEVER an access detail, even with every secret field set."""
    db = SessionLocal()
    c = p = u = None
    try:
        c = Client(name="Day Plan Client", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="Plan Cottage", address="5 Plan Ln",
                     property_type="str", active=True, org_id=1,
                     access_notes="Lockbox 8712 behind the shed",
                     house_code="4321#", wifi_ssid="PlanNet",
                     wifi_password="plan-secret")
        db.add(p); db.commit(); db.refresh(p)
        u = _seed_cleaner(db, email="dayplan-cleaner@example.com")
        day = date.today() + timedelta(days=1)
        db.add_all([
            Job(client_id=c.id, property_id=p.id, org_id=1,
                job_type="str_turnover", title="Turnover",
                scheduled_date=day, start_time=time(9, 0), end_time=time(12, 0),
                status="scheduled", cleaner_ids=["C-DAYPLAN"]),
            # 15-min gap → the tight-turnaround flag fires in the facts.
            Job(client_id=c.id, property_id=p.id, org_id=1,
                job_type="residential", title="Standard clean",
                scheduled_date=day, start_time=time(12, 15), end_time=time(15, 0),
                status="scheduled", cleaner_ids=["C-DAYPLAN"]),
            # Somebody else's job the same day — must NOT ride this draft.
            Job(client_id=c.id, property_id=p.id, org_id=1,
                job_type="residential", title="Ghost Job",
                scheduled_date=day, start_time=time(10, 0),
                status="scheduled", cleaner_ids=["C-SOMEONE-ELSE"]),
        ])
        db.commit()

        r = api.post(f"/api/ai/draft-crew-message/{u.id}",
                     json={"date": day.isoformat()})
        assert r.status_code == 200, r.text
        body = r.json()
        assert not body.get("error")
        msg = body["message"]
        assert "Dana" in msg                       # greeted by first name
        assert "Day Plan Client" in msg            # client name
        assert "09:00" in msg and "12:15" in msg   # lineup in time order
        assert "5 Plan Ln" in msg                  # street address
        assert "Ghost Job" not in msg              # only THEIR jobs
        assert "day view" in msg.lower()           # details live in the app
        # Crown jewels: no access/credential value may reach the message
        # (this is the fallback path, so it also proves the prompt facts —
        # both render from the same _crew_job_facts output).
        for secret in ("4321#", "8712", "Lockbox", "shed",
                       "PlanNet", "plan-secret"):
            assert secret not in msg, f"access detail {secret!r} leaked into draft"
    finally:
        db.rollback()
        _cleanup_users(db, [u.id] if u else [])
        _cleanup(db, client_ids=[c.id] if c else (),
                 property_ids=[p.id] if p else ())
        db.close()


def test_draft_crew_message_cross_org_cleaner_is_invisible(api):
    """Another tenant's cleaner reads as nonexistent — same envelope the
    other draft endpoints use, no existence leak."""
    db = SessionLocal()
    u = None
    try:
        _ensure_org2(db)
        u = _seed_cleaner(db, email="rival-cleaner@example.com",
                          cleaner_id="C-RIVAL", org_id=2)
        r = api.post(f"/api/ai/draft-crew-message/{u.id}", json={})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("error") == "Cleaner not found"
        assert body.get("subject") == "" and body.get("message") == ""
    finally:
        db.rollback()
        _cleanup_users(db, [u.id] if u else [])
        db.close()


def test_draft_crew_message_free_day_is_friendly_not_error(api):
    """No jobs that day → a warm 'nothing scheduled' message, not an error
    (the owner may still want to send it)."""
    db = SessionLocal()
    u = None
    try:
        u = _seed_cleaner(db, email="freeday-cleaner@example.com",
                          cleaner_id="C-FREEDAY")
        # Far-future date nothing else in the shared DB could have seeded.
        day = date.today() + timedelta(days=200)
        r = api.post(f"/api/ai/draft-crew-message/{u.id}",
                     json={"date": day.isoformat()})
        assert r.status_code == 200, r.text
        body = r.json()
        assert not body.get("error")
        assert "Dana" in body["message"]
        assert "nothing on the schedule" in body["message"].lower()
    finally:
        db.rollback()
        _cleanup_users(db, [u.id] if u else [])
        db.close()


# ── GET /api/ai/daily-brief ─────────────────────────────────────────────────

@pytest.fixture(autouse=False)
def _clear_brief_cache():
    """The per-business-day cache is module state — each test starts clean so
    a brief cached by one test can't satisfy (or poison) another."""
    ai_router._BRIEF_CACHE.clear()
    yield
    ai_router._BRIEF_CACHE.clear()


def test_daily_brief_fallback_shape_without_model(api, monkeypatch, _clear_brief_cache):
    """No anthropic client → the deterministic fallback still returns the full
    contract: a non-empty brief, an ISO generated_at, ai=False, and the same
    items list /followup-check serves (the strip must never need two calls)."""
    monkeypatch.setattr(ai_router, "_anthropic_client", lambda: None)
    r = api.get("/api/ai/daily-brief")
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body.get("brief"), str) and body["brief"]
    assert body.get("ai") is False
    datetime.fromisoformat(body["generated_at"])  # raises if not ISO
    assert isinstance(body.get("items"), list)
    # The items really are the followup list, not a re-shaped copy.
    db = SessionLocal()
    try:
        expected = _compute_followups(db, 1)["followups"]
    finally:
        db.close()
    assert [i["title"] for i in body["items"]] == [i["title"] for i in expected]


def test_daily_brief_caches_prose_per_day_and_refresh_busts(api, monkeypatch,
                                                            _clear_brief_cache):
    """Second call the same day returns the SAME generated_at without a second
    model call; ?refresh=1 regenerates. Counted via a fake client so the test
    proves the cache short-circuits the model, not just that timestamps match."""
    from types import SimpleNamespace

    calls = []

    class _FakeMessages:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(content=[
                SimpleNamespace(type="text", text="All quiet — 2 jobs today.")])

    fake = SimpleNamespace(messages=_FakeMessages())
    monkeypatch.setattr(ai_router, "_anthropic_client", lambda: fake)

    r1 = api.get("/api/ai/daily-brief")
    assert r1.status_code == 200, r1.text
    b1 = r1.json()
    assert b1["brief"] == "All quiet — 2 jobs today."
    assert b1["ai"] is True
    assert len(calls) == 1

    r2 = api.get("/api/ai/daily-brief")
    b2 = r2.json()
    assert b2["generated_at"] == b1["generated_at"]
    assert b2["brief"] == b1["brief"]
    assert len(calls) == 1, "cached day must not trigger a second model call"

    r3 = api.get("/api/ai/daily-brief?refresh=1")
    assert r3.status_code == 200
    assert len(calls) == 2, "?refresh=1 must regenerate"


def test_daily_brief_is_org_scoped(api, monkeypatch, _clear_brief_cache):
    """An org-1 overdue invoice shows in org 1's items and never in org 2's —
    the brief aggregates money/jobs across the business, so an unscoped scan
    here would leak one tenant's numbers into another's morning readout."""
    monkeypatch.setattr(ai_router, "_anthropic_client", lambda: None)

    def overdue_count(items):
        # The scan aggregates into one "<n> overdue invoice(s)" item; absent
        # item means zero. Delta-based so rows left behind by OTHER tests in
        # the shared DB can't turn this into a flake.
        item = next((i for i in items if "overdue invoice" in i["title"]), None)
        return int(item["title"].split()[0]) if item else 0

    def fetch(org):
        app.dependency_overrides[current_org_id] = lambda: org
        return api.get("/api/ai/daily-brief").json()

    db = SessionLocal()
    c = None
    try:
        _ensure_org2(db)
        before1 = overdue_count(fetch(1)["items"])
        before2 = overdue_count(fetch(2)["items"])

        c = Client(name="Brief Owner", email="brief@example.com",
                   status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        db.add(Invoice(client_id=c.id, org_id=1, status="overdue",
                       total=432.0, invoice_number="INV-BRIEF-1"))
        db.commit()

        # Org 1 sees its new overdue invoice; org 2's readout is unchanged.
        assert overdue_count(fetch(1)["items"]) == before1 + 1
        assert overdue_count(fetch(2)["items"]) == before2
        # And the cached prose is keyed per org — each org got its own entry.
        assert {k[0] for k in ai_router._BRIEF_CACHE} == {1, 2}
    finally:
        app.dependency_overrides[current_org_id] = lambda: 1
        db.rollback()
        _cleanup(db, client_ids=[c.id] if c else ())
        db.close()
