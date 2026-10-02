"""GET /api/invoices/summary reports the ACCURATE money headline across ALL of
the org's invoices — not just the paginated (default 50) list the page shows.

Pins the definitions the KPI band + AR aging read as fact:
  collected   = sum of PAID invoice totals
  outstanding = sum of SENT + OVERDUE totals (matches the board's "outstanding")
  overdue_*   = OVERDUE totals + count
  aging       = outstanding split by days past due (current / 1–30 / 31–60 / 60+)
Draft invoices are excluded from every figure.

Asserted by DELTA (before vs after) so rows the shared test DB already holds
don't skew the numbers.
"""
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Invoice
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7733, 1, "admin", "active", True
    email = "invoice-summary-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    client = TestClient(app)
    ids = {"clients": [], "invoices": []}
    yield client, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    for model, key in ((Invoice, "invoices"), (Client, "clients")):
        db.query(model).filter(model.id.in_(ids[key] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _iso(days_from_today):
    return (date.today() + timedelta(days=days_from_today)).isoformat()


def test_summary_is_accurate_across_all_invoices(api):
    client, ids = api
    before = client.get("/api/invoices/summary").json()

    db = SessionLocal()
    c = Client(name=f"SumTest {uuid.uuid4().hex[:8]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)

    def inv(status, total, due_days=None):
        return Invoice(client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
                       status=status, total=total,
                       due_date=_iso(due_days) if due_days is not None else None, org_id=1)

    rows = [
        inv("paid", 300.0),                 # collected +300
        inv("sent", 200.0, due_days=10),    # outstanding, current (not yet due)
        inv("sent", 100.0, due_days=-15),   # outstanding, 1–30
        inv("overdue", 50.0, due_days=-45), # outstanding + overdue, 31–60
        inv("overdue", 80.0, due_days=-90), # outstanding + overdue, 60+
        inv("draft", 999.0),                # excluded everywhere
    ]
    db.add_all(rows); db.commit()
    for r in rows: db.refresh(r); ids["invoices"].append(r.id)
    db.close()

    after = client.get("/api/invoices/summary").json()
    d = lambda k: round(after[k] - before[k], 2)
    assert d("collected") == 300.0
    assert d("outstanding") == 430.0          # 200 + 100 + 50 + 80 (draft excluded)
    assert d("overdue_total") == 130.0        # 50 + 80
    assert after["overdue_count"] - before["overdue_count"] == 2
    da = lambda k: round(after["aging"][k] - before["aging"][k], 2)
    assert da("current") == 200.0
    assert da("d1_30") == 100.0
    assert da("d31_60") == 50.0
    assert da("d60_plus") == 80.0


def test_summary_ignores_the_list_status_filter(api):
    # The endpoint takes no status param — it's always all-invoices, so the tiles
    # stay accurate no matter which tab the list is filtered to.
    client, _ = api
    r = client.get("/api/invoices/summary?status=paid")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"collected", "outstanding", "overdue_total", "overdue_count", "aging"}
    assert set(body["aging"]) == {"current", "d1_30", "d31_60", "d60_plus"}
