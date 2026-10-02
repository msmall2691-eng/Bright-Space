"""GET /api/clients?with_stats=true adds each client's outstanding balance and
next upcoming visit — in two batched aggregates, never a query per client.

Pins the two definitions so they can't silently drift:
  balance    = sum of this client's SENT + OVERDUE invoice totals (matches the
               board's "outstanding" — draft and paid are excluded).
  next_visit = the earliest scheduled/in-progress visit dated today or later
               (past and cancelled visits are excluded).
And that without with_stats both come back null, so the many client-book
preloaders don't pay for the aggregates.
"""
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, Invoice
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 7611, 1, "admin", "active", True
    email = "clients-stats-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    client = TestClient(app)
    ids = {"clients": [], "properties": [], "jobs": [], "invoices": []}
    yield client, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    for model, key in ((Invoice, "invoices"), (Job, "jobs"),
                       (Property, "properties"), (Client, "clients")):
        db.query(model).filter(model.id.in_(ids[key] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _row(api, ids):
    """One client with a mix of invoices + jobs; returns (client_dict_fetcher,
    name, expected). Uses a unique name so we can `search` to just this row."""
    name = f"StatsTest {uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    c = Client(name=name, status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name="1 Test Way", address="1 Test Way",
                 property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)

    invs = [
        Invoice(client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:8]}", status="sent", total=200.0, org_id=1),
        Invoice(client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:8]}", status="overdue", total=50.0, org_id=1),
        Invoice(client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:8]}", status="paid", total=999.0, org_id=1),
        Invoice(client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:8]}", status="draft", total=40.0, org_id=1),
    ]
    db.add_all(invs); db.commit()
    for inv in invs: db.refresh(inv); ids["invoices"].append(inv.id)

    today = business_today()
    soon = today + timedelta(days=5)
    jobs = [
        Job(client_id=c.id, property_id=p.id, job_type="residential", title="Next",
            scheduled_date=soon, status="scheduled", cleaner_ids=[], org_id=1),
        Job(client_id=c.id, property_id=p.id, job_type="residential", title="Later",
            scheduled_date=today + timedelta(days=20), status="scheduled", cleaner_ids=[], org_id=1),
        Job(client_id=c.id, property_id=p.id, job_type="residential", title="Past",
            scheduled_date=today - timedelta(days=3), status="scheduled", cleaner_ids=[], org_id=1),
        Job(client_id=c.id, property_id=p.id, job_type="residential", title="Cancelled soon",
            scheduled_date=today + timedelta(days=1), status="cancelled", cleaner_ids=[], org_id=1),
    ]
    db.add_all(jobs); db.commit()
    for j in jobs: db.refresh(j); ids["jobs"].append(j.id)
    db.close()
    return name, soon.isoformat()


def _find(api, name, **params):
    params["search"] = name
    rows = api.get("/api/clients", params=params).json()
    match = [r for r in rows if r["name"] == name]
    assert len(match) == 1, f"expected exactly one {name}, got {len(match)}"
    return match[0]


def test_with_stats_reports_balance_and_next_visit(api):
    client, ids = api
    name, soon = _row(client, ids)
    row = _find(client, name, with_stats="true")
    # 200 (sent) + 50 (overdue); 999 paid + 40 draft excluded.
    assert row["balance"] == 250.0
    # earliest FUTURE non-cancelled visit; past + cancelled excluded.
    assert row["next_visit"] == soon


def test_without_stats_both_are_null(api):
    client, ids = api
    name, _ = _row(client, ids)
    row = _find(client, name)  # no with_stats
    assert row["balance"] is None
    assert row["next_visit"] is None


def test_client_with_no_money_or_visits_reads_zero_balance_no_visit(api):
    client, ids = api
    db = SessionLocal()
    name = f"StatsTest {uuid.uuid4().hex[:8]}"
    c = Client(name=name, status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id); db.close()
    row = _find(client, name, with_stats="true")
    assert row["balance"] == 0.0        # nothing owed → 0, not null, under with_stats
    assert row["next_visit"] is None    # nothing scheduled
