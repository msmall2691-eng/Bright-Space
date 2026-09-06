"""Agent tools read the whole business. They must read one org's worth of it.

Every query in agents/tools.py was unscoped, and the session was opened straight
from SessionLocal — which also meant the per-transaction GUC `app.current_org_id`
was never set, so Postgres RLS matched every row instead of denying it. Two
layers missing at once: no filter, and no backstop behind the missing filter.

The tools return the client list, the job list and the outstanding-invoice
total. Single-tenant today; the day that stops being true is not a day anybody
thinks to audit an agent tool file.

Pinned here: the filter, the fallback (an unknown org resolves to the DEFAULT
WORKSPACE, never to "no filter"), and the RLS context being set at all.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Invoice, Job, Property, User


@pytest.fixture
def two_orgs():
    made = {"clients": [], "properties": [], "jobs": [], "invoices": []}
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    mine = Client(name=f"Mine {tag}", status="active", org_id=1)
    theirs = Client(name=f"Theirs {tag}", status="active", org_id=2)
    db.add_all([mine, theirs]); db.commit(); db.refresh(mine); db.refresh(theirs)
    made["clients"] += [mine.id, theirs.id]
    names = (mine.name, theirs.name)
    ids = (mine.id, theirs.id)
    db.close()
    yield names, ids, made
    db = SessionLocal()
    db.query(Invoice).filter(Invoice.id.in_(made["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_another_orgs_clients_never_reach_an_agent(two_orgs):
    from agents.tools import execute_tool

    (mine, theirs), _, _ = two_orgs
    out = execute_tool("get_clients", {"limit": 500}, "finn", org_id=1)
    blob = repr(out)
    assert mine in blob
    assert theirs not in blob, "an agent read another org's customer"


def test_the_snapshot_counts_one_org_not_all_of_them(two_orgs):
    """Counts, not just listings — a leaky aggregate is still a leak, and it is
    the one nobody notices because it looks like a number rather than a name."""
    from agents.tools import execute_tool

    _, (mine_id, theirs_id), made = two_orgs
    # A second client in org 1 only, so the two orgs' counts genuinely differ
    # and an equal-by-coincidence result cannot pass this.
    db = SessionLocal()
    extra = Client(name=f"Mine2 {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(extra); db.commit(); db.refresh(extra)
    made["clients"].append(extra.id)
    everything = db.query(Client).count()
    ours_expected = db.query(Client).filter(Client.org_id.in_((1,)) | Client.org_id.is_(None)).count()
    db.close()

    ours = execute_tool("get_business_snapshot", {}, "finn", org_id=1)
    theirs = execute_tool("get_business_snapshot", {}, "finn", org_id=2)

    assert ours["clients_total"] == ours_expected
    assert ours["clients_total"] != theirs["clients_total"]
    assert ours["clients_total"] < everything, "the snapshot counted every org"


def test_an_unknown_org_falls_back_to_the_default_workspace_not_to_everything(two_orgs):
    """`org_id=None` reaching a tool used to mean NO FILTER. It now resolves the
    same way resolve_org_id() does everywhere else — to the default workspace.
    A helper that forgets to thread its org must read one tenant, not all."""
    from agents.tools import execute_tool

    (mine, theirs), _, _ = two_orgs
    blob = repr(execute_tool("get_clients", {"limit": 500}, "finn"))
    assert theirs not in blob, "an unthreaded org read every tenant's customers"


def test_the_rls_backstop_is_armed(monkeypatch):
    """The filter is the fix; RLS is what catches the query that forgets it.
    Opening SessionLocal directly left the GUC unset, which on Postgres makes
    the policy match everything rather than deny."""
    import agents.tools as tools
    seen = {}

    real = tools.__dict__.get("_set_rls_probe")

    from modules.auth import router as auth_router
    original = auth_router.set_rls_org_context

    def spy(db, oid):
        seen["oid"] = oid
        return original(db, oid)

    monkeypatch.setattr(auth_router, "set_rls_org_context", spy)
    execute = tools.execute_tool
    execute("get_business_snapshot", {}, "finn", org_id=7)
    assert seen.get("oid") == 7, "the org GUC was never set for the tool session"
