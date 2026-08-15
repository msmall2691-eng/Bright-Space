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
    Client, ICalEvent, Invoice, Job, Org, Property, PropertyIcal, Quote,
)
from modules.auth.router import current_org_id, get_current_user
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
