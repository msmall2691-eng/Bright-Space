"""Multi-tenancy BB-SEC-22: the comms inbox is scoped to the caller's workspace.

Every authenticated endpoint in modules/comms/router.py queried `Conversation`
by id with no org filter, guarded only by `require_role("admin","manager")`.
RLS did not save it: `app.current_org_id` is set ONLY by the `current_org_id`
dependency (modules/auth/router.py), none of these routes depended on it, and
the policy in database/rls.py fails open on a NULL GUC
(`... OR current_setting('app.current_org_id', true) IS NULL`).

So a manager in any workspace could read another workspace's whole thread AND
send an SMS or email on it — `send_reply` resolves `to_addr` server-side from
that org's client, so the message reached their customer on this account's
Twilio. These tests are the permanent "a non-owner gets denied" pass for the
inbox: read, mutate, send, and the two aggregate endpoints that leaked counts.

The suite authenticates with the master API key, which resolves to the default
org (1), so a row planted in OTHER_ORG must be invisible.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message

client = TestClient(app)
OTHER_ORG = 99999  # a workspace the API-key caller is NOT in


def _mk_conv(db, org_id, *, channel="sms", contact="+15550001111", unread=3):
    c = Conversation(channel=channel, status="open", external_contact=contact,
                     unread_count=unread, org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _cleanup(db, conv_ids, client_ids=()):
    db.query(Message).filter(Message.conversation_id.in_(conv_ids)).delete(synchronize_session=False)
    db.query(Conversation).filter(Conversation.id.in_(conv_ids)).delete(synchronize_session=False)
    if client_ids:
        db.query(Client).filter(Client.id.in_(client_ids)).delete(synchronize_session=False)
    db.commit(); db.close()


def test_other_org_conversation_is_invisible_to_list_and_detail():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    other = _mk_conv(db, OTHER_ORG, contact=f"+1555{tag[:7]}")
    mine = _mk_conv(db, 1, contact=f"+1666{tag[:7]}")
    try:
        ids = {r["id"] for r in client.get("/api/comms/conversations?limit=500").json()}
        assert other.id not in ids, "cross-tenant conversation leaked into the inbox list"
        assert mine.id in ids, "own-org conversation must still be listed"

        # Detail reads as 404 — "doesn't exist" and "isn't yours" collapse, so
        # the response can't be used to probe which ids are real.
        assert client.get(f"/api/comms/conversations/{other.id}").status_code == 404
        assert client.get(f"/api/comms/conversations/{mine.id}").status_code == 200
    finally:
        _cleanup(db, [other.id, mine.id])


def test_cannot_send_on_another_orgs_conversation():
    """The one with real-world cost: a send would text that org's customer."""
    db = SessionLocal()
    other = _mk_conv(db, OTHER_ORG, contact=f"+1555{uuid.uuid4().hex[:7]}")
    try:
        r = client.post(f"/api/comms/conversations/{other.id}/messages",
                        json={"body": "cross-tenant send"})
        assert r.status_code == 404, f"expected 404, got {r.status_code}: {r.text}"
        db.expire_all()
        assert db.query(Message).filter(Message.conversation_id == other.id).count() == 0, \
            "a message row was written on another org's conversation"
    finally:
        _cleanup(db, [other.id])


def test_cannot_mutate_another_orgs_conversation():
    db = SessionLocal()
    other = _mk_conv(db, OTHER_ORG, contact=f"+1555{uuid.uuid4().hex[:7]}", unread=4)
    cid = other.id
    try:
        for path, body in [
            (f"/api/comms/conversations/{cid}/status", {"status": "resolved"}),
            (f"/api/comms/conversations/{cid}/priority", {"priority": "urgent"}),
            (f"/api/comms/conversations/{cid}/tags", {"tags": ["hacked"]}),
            (f"/api/comms/conversations/{cid}/read", None),
            (f"/api/comms/conversations/{cid}/assign", {"assignee": "someone"}),
            (f"/api/comms/conversations/{cid}/notes", {"body": "note"}),
            (f"/api/comms/conversations/{cid}/link-client", {"client_id": None}),
        ]:
            r = client.post(path, json=body) if body is not None else client.post(path)
            assert r.status_code == 404, f"{path} returned {r.status_code}, expected 404"

        db.expire_all()
        row = db.query(Conversation).filter(Conversation.id == cid).first()
        assert row is not None
        assert row.status == "open", "status was mutated across tenants"
        assert row.priority != "urgent", "priority was mutated across tenants"
        assert "hacked" not in (row.tags or []), "tags were mutated across tenants"
        assert row.unread_count == 4, "unread_count was cleared across tenants"
        assert row.assignee is None, "assignee was set across tenants"
    finally:
        _cleanup(db, [cid])


def test_summary_counts_exclude_other_orgs():
    """The summary drives the unread chime; it counted every workspace."""
    db = SessionLocal()
    base = client.get("/api/comms/conversations/summary").json()
    other = _mk_conv(db, OTHER_ORG, contact=f"+1555{uuid.uuid4().hex[:7]}", unread=7)
    try:
        after = client.get("/api/comms/conversations/summary").json()
        assert after["open"] == base["open"], "another org's open thread moved the badge"
        assert after["unread_messages"] == base["unread_messages"], \
            "another org's unread messages leaked into the chime count"
    finally:
        _cleanup(db, [other.id])


def test_client_comms_rejects_another_orgs_client():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    c = Client(name=f"Other Org Client {tag}", status="lead", org_id=OTHER_ORG)
    db.add(c); db.commit(); db.refresh(c)
    try:
        assert client.get(f"/api/comms/client/{c.id}").status_code == 404
    finally:
        _cleanup(db, [], [c.id])


def test_assignee_picker_excludes_other_orgs_staff():
    """Leaked staff name, email and role. NULL-org users must stay pickable:
    `users` has no RLS policy and no completed org_id backfill (rls.py)."""
    from database.models import User
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    other = User(email=f"other-{tag}@example.com", full_name=f"Other Staff {tag}",
                 role="manager", status="active", password_hash="x", org_id=OTHER_ORG)
    legacy = User(email=f"legacy-{tag}@example.com", full_name=f"Legacy Staff {tag}",
                  role="manager", status="active", password_hash="x", org_id=None)
    db.add_all([other, legacy]); db.commit(); db.refresh(other); db.refresh(legacy)
    try:
        ids = {r["id"] for r in client.get("/api/comms/assignees").json()}
        assert other.id not in ids, "another workspace's staff leaked into the picker"
        assert legacy.id in ids, "NULL-org (legacy) staff must remain pickable"
    finally:
        db.query(User).filter(User.id.in_([other.id, legacy.id])).delete(synchronize_session=False)
        db.commit(); db.close()

def test_legacy_null_org_rows_stay_visible():
    """BB-SEC-24 — the regression BB-SEC-22's first cut shipped.

    A production census found 85 of 126 conversations and 517 of 1,304 messages
    carry org_id IS NULL, despite migration 027's backfill. The strict
    `org_id == org_id` filter excluded them, hiding two thirds of the office
    inbox. A NULL org_id means "the default workspace" (database/rls.py,
    modules/ai/router.py `_org()`), so it must match.

    This is the guard against someone "hardening" the filter back.
    """
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    legacy = _mk_conv(db, None, contact=f"+1777{tag[:7]}", unread=2)   # pre-tenancy row
    mine   = _mk_conv(db, 1,    contact=f"+1888{tag[:7]}", unread=1)
    other  = _mk_conv(db, OTHER_ORG, contact=f"+1999{tag[:7]}", unread=9)
    try:
        ids = {r["id"] for r in client.get("/api/comms/conversations?limit=500").json()}
        assert legacy.id in ids, "legacy NULL-org conversation vanished from the inbox"
        assert mine.id in ids
        assert other.id not in ids, "cross-tenant conversation leaked"

        assert client.get(f"/api/comms/conversations/{legacy.id}").status_code == 200, \
            "legacy NULL-org conversation must still open"

        # and it must stay actionable, not just visible
        assert client.post(f"/api/comms/conversations/{legacy.id}/read").status_code == 200
    finally:
        _cleanup(db, [legacy.id, mine.id, other.id])


def test_summary_counts_include_legacy_null_org_rows():
    """The unread chime reads this; a NULL-org thread must still count."""
    db = SessionLocal()
    base = client.get("/api/comms/conversations/summary").json()
    legacy = _mk_conv(db, None, contact=f"+1777{uuid.uuid4().hex[:7]}", unread=5)
    try:
        after = client.get("/api/comms/conversations/summary").json()
        assert after["open"] == base["open"] + 1, "legacy NULL-org thread missing from counts"
        assert after["unread_messages"] == base["unread_messages"] + 5
    finally:
        _cleanup(db, [legacy.id])

def test_null_org_rows_are_NOT_visible_to_a_non_default_workspace():
    """Codex review on #1083, P1: a NULL org_id means THE DEFAULT workspace,
    not every workspace. The first cut of the NULL arm admitted orphan rows for
    any tenant — harmless today with one workspace, a real leak the moment a
    second exists. Only the default workspace may see them."""
    from modules.comms import router as comms_router
    from modules.auth.router import _default_org_id
    db = SessionLocal()
    legacy = _mk_conv(db, None, contact=f"+1777{uuid.uuid4().hex[:7]}")
    try:
        default_org = _default_org_id(db); db.commit()
        # The caller in this suite IS the default workspace, so it sees it...
        assert client.get(f"/api/comms/conversations/{legacy.id}").status_code == 200

        # ...but the predicate for any OTHER workspace must exclude NULL.
        comms_router._DEFAULT_ORG_CACHE = None
        other = comms_router._org(Conversation, OTHER_ORG, db)
        rendered = str(other.compile(compile_kwargs={"literal_binds": True}))
        assert "IS NULL" not in rendered, (
            f"non-default workspace got the NULL arm: {rendered}")

        # and the default workspace's predicate does carry it
        mine = comms_router._org(Conversation, default_org, db)
        assert "IS NULL" in str(mine.compile(compile_kwargs={"literal_binds": True}))
    finally:
        comms_router._DEFAULT_ORG_CACHE = None
        _cleanup(db, [legacy.id])
