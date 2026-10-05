"""Searching Properties by client name matched nothing, silently.

`usePropertyFilters` filters properties on `name / address / client_name` and
its docstring says so — but `prop_to_dict` never sent `client_name`, so the
third of those three was always `undefined`. Typing a client's name into the
Properties search returned an empty list and looked like "this client has no
properties", which is a worse failure than an error.

The field rides the existing payload rather than costing a second request
(brightbase-economy rule 3), exactly as `_quote_dict` already does for quotes.

The last test is the one that would have caught the original bug: it asserts
the FRONTEND's filter expression works against a REAL payload, rather than
just that some key is present.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7821, 1, "admin", "active", True
    email = "props-cn@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def seeded():
    """A client with a distinctive name, and one property belonging to them."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    cl = Client(name=f"Harborview Rentals {tag}", email=f"hv-{tag}@example.com",
                status="active", org_id=1)
    db.add(cl); db.commit(); db.refresh(cl)
    pr = Property(client_id=cl.id, name=f"Dock House {tag}", address="12 Pier Rd",
                  city="Portland", state="ME", property_type="str",
                  active=True, org_id=1)
    db.add(pr); db.commit(); db.refresh(pr)
    out = (cl.id, cl.name, pr.id, pr.name)
    db.close()
    yield out
    db = SessionLocal()
    db.query(Property).filter(Property.id == out[2]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == out[0]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_list_includes_client_name(api, seeded):
    _, client_name, prop_id, _ = seeded
    rows = api.get("/api/properties?include_inactive=true").json()
    row = next((r for r in rows if r["id"] == prop_id), None)
    assert row is not None
    assert row["client_name"] == client_name


def test_single_get_includes_it_too(api, seeded):
    _, client_name, prop_id, _ = seeded
    row = api.get(f"/api/properties/{prop_id}").json()
    assert row["client_name"] == client_name


def test_a_property_with_no_client_reports_None_not_a_crash():
    """The guard for production's drifted rows.

    `schema-guardian` records that prod drifted to a NULLABLE
    `Property.client_id` despite the model declaring it NOT NULL, and
    `data-doctor` reports those rows. So a property with no client is a shape
    that exists in production and nowhere else — the local SQLite schema
    enforces NOT NULL, which is why this cannot be built through the API here.

    Called directly, which is the honest way to cover it: the point is that
    `p.client.name` is guarded, not that a row can be inserted.
    """
    from modules.properties.router import prop_to_dict

    orphan = Property(client_id=None, name="Orphan", address="1 Nowhere",
                      property_type="residential", active=True)
    data = prop_to_dict(orphan, include_icals=False)
    assert data["client_name"] is None
    assert data["client_id"] is None


def test_the_frontend_filter_expression_now_matches(api, seeded):
    """The actual bug, reproduced against a real payload.

    This mirrors usePropertyFilters.js:28 —
        [p.name, p.address, p.client_name].some(v => (v||'').toLowerCase().includes(q))
    — and searches for the CLIENT's name, which is not in the property's own
    name or address. Before this change the third element was undefined, so
    the match was impossible and the list came back empty.
    """
    _, client_name, prop_id, prop_name = seeded
    rows = api.get("/api/properties?include_inactive=true").json()
    row = next(r for r in rows if r["id"] == prop_id)

    needle = client_name.split()[0].lower()          # "harborview"
    assert needle not in (row["name"] or "").lower()        # not findable by property name
    assert needle not in (row["address"] or "").lower()     # nor by address

    matched = any(
        needle in (v or "").lower()
        for v in (row.get("name"), row.get("address"), row.get("client_name"))
    )
    assert matched, "searching Properties by client name still finds nothing"
