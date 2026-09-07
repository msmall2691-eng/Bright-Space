"""Month-to-date revenue, and which month an evening payment belongs to.

`Invoice.paid_at` is stored as naive UTC. The month cutoff was
`datetime.now().replace(day=1, …)` — the SERVER's clock, which in the
container is UTC — so "this month" began at 00:00 UTC, which is 8pm on the
last day of the previous month in Maine.

Every invoice paid in that evening window landed in the wrong month: the month
just ended lost revenue it had earned, and the new one gained revenue it had
not. Four or five hours of wrong numbers at every month boundary, on the
figure the owner checks first and the last one anybody would think to doubt.

Also pinned: the summary is org-scoped. It was role-gated with no tenant
filter, so the totals summed every workspace's paid invoices together.
"""
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Invoice, Job, Property
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_tz


class _Admin:
    id, org_id, role, status, active = 9801, 1, "admin", "active", True
    email, full_name, cleaner_id = "money@example.com", "The Office", None


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "invoices": []}
    yield ids
    db = SessionLocal()
    db.query(Invoice).filter(
        Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(
        Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(
        Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _paid_invoice(ids, *, paid_at_utc, total, org_id=1, job_type="residential"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Rev {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"1 Rev {tag}", address=f"1 Rev {tag}", org_id=org_id)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type=job_type, title="Clean",
            status="completed", org_id=org_id)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    inv = Invoice(client_id=c.id, job_id=j.id, org_id=org_id, status="paid",
                  total=total, paid_at=paid_at_utc,
                  invoice_number=f"INV-{tag}")
    db.add(inv); db.commit(); db.refresh(inv); ids["invoices"].append(inv.id)
    db.close()


def _mtd_total():
    r = _api().get("/api/invoices/summary/by-service?period=mtd")
    assert r.status_code == 200, r.text
    return round(sum(row["total"] for row in r.json()["by_service"]), 2)


def _boundary_utc():
    """The last evening of the previous month, in Maine, as naive UTC.

    9pm Maine on the last day of the month is already the 1st in UTC — which
    is exactly the window the old cutoff mis-filed.
    """
    tz = business_tz()
    local_first = datetime.now(tz).replace(day=1, hour=0, minute=0, second=0,
                                           microsecond=0)
    # One hour BEFORE the local month started: still last month in Maine.
    before_local = local_first.timestamp() - 3600
    return (datetime.fromtimestamp(before_local, tz)
            .astimezone(timezone.utc).replace(tzinfo=None))


# ── The bug ─────────────────────────────────────────────────────────────────

def test_a_payment_taken_last_month_in_maine_is_not_this_months_revenue(ids):
    """An invoice paid at 11pm on the last day of the month, Maine time, is
    already the 1st in UTC. The old cutoff counted it as the new month's."""
    before = _mtd_total()
    _paid_invoice(ids, paid_at_utc=_boundary_utc(), total=500.0)

    assert _mtd_total() == before, (
        "an evening payment from last month leaked into month-to-date")


def test_a_payment_taken_this_month_still_counts(ids):
    """The other direction, so the fix cannot be "exclude everything"."""
    tz = business_tz()
    local_first = datetime.now(tz).replace(day=1, hour=0, minute=0, second=0,
                                           microsecond=0)
    an_hour_in = datetime.fromtimestamp(local_first.timestamp() + 3600, tz)
    before = _mtd_total()
    _paid_invoice(ids,
                  paid_at_utc=an_hour_in.astimezone(timezone.utc).replace(tzinfo=None),
                  total=250.0)

    assert _mtd_total() == round(before + 250.0, 2)


# ── Scope ───────────────────────────────────────────────────────────────────

def test_another_orgs_revenue_is_not_in_your_total(ids):
    tz = business_tz()
    now_local = datetime.now(tz)
    mid_month = now_local.replace(day=1, hour=12).astimezone(timezone.utc).replace(tzinfo=None)
    before = _mtd_total()
    _paid_invoice(ids, paid_at_utc=mid_month, total=9999.0, org_id=2)

    assert _mtd_total() == before, "another workspace's money is in your revenue"
