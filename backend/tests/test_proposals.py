"""Autopilot approval gate (proposed_actions, migration 091).

The contract under test (scheduling-invariants):
  - Automation proposes; only a human decision executes — and execution goes
    through the SAME write path the dispatch board uses (scheduling's
    update_job), never a raw Job.cleaner_ids write.
  - The propose mode rides the EXISTING STR turnover auto-assign tick (R1) as
    a dry run + ProposedAction rows: it must assign NOTHING itself and must be
    idempotent across runs (dedupe guard).
  - Proposals are tenant rows: cross-org ids 404 (same idiom as
    test_tenancy_scope_job_actions.py).
  - A failing execution records status='failed' with the error in result —
    the decision is never lost to a 500.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import AppSetting, Client, Job, ProposedAction, Property, User
from services.proposals import create_proposal, execute_proposal

client = TestClient(app)
OTHER_ORG = 99999


def _future(days=30):
    return date.today() + timedelta(days=days)


def _seed_job(db, org_id=1, *, assigned=None, days_out=30):
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"ProposalOwner {tag}", status="active",
               email=f"prop-{tag}@example.com", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"Sea Rose {tag}", address="1 Proposal St",
                 property_type="str", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title=f"Turnover {tag}",
            job_type="str_turnover", scheduled_date=_future(days_out),
            start_time=time(10, 0), end_time=time(13, 0),
            status="scheduled", cleaner_ids=assigned, org_id=org_id)
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def _seed_cleaner(db, org_id=1):
    tag = uuid.uuid4().hex[:6]
    crew_id = f"crew-{tag}"
    u = User(email=f"cleaner-{tag}@example.com", full_name=f"Ana {tag}",
             role="cleaner", active=True, org_id=org_id, cleaner_id=crew_id)
    db.add(u); db.commit(); db.refresh(u)
    return u, crew_id


def _cleanup(db, *, jobs=(), props=(), clients=(), users=(), proposal_ids=(),
             setting_keys=()):
    if proposal_ids:
        db.query(ProposedAction).filter(
            ProposedAction.id.in_(list(proposal_ids))).delete(synchronize_session=False)
    for j in jobs:
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    for p in props:
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    for c in clients:
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    for u in users:
        db.query(User).filter(User.id == u.id).delete(synchronize_session=False)
    for k in setting_keys:
        db.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    db.commit(); db.close()


def _job_proposal_ids(db, job_id):
    return [p.id for p in db.query(ProposedAction).filter(
        ProposedAction.kind == "assign_cleaner").all()
        if (p.payload or {}).get("job_id") == job_id]


# ── create + dedupe ─────────────────────────────────────────────────────────

def test_create_proposal_dedupes_identical_pending():
    db = SessionLocal()
    marker = uuid.uuid4().hex
    payload = {"conversation_id": 424242, "body": f"Hi! ({marker})"}
    ids = []
    try:
        first = create_proposal(db, org_id=1, agent_id="mia", kind="send_sms",
                                title="Text the guest", detail=None, payload=payload)
        ids.append(first.id)
        again = create_proposal(db, org_id=1, agent_id="mia", kind="send_sms",
                                title="Text the guest", detail=None, payload=dict(payload))
        assert again.id == first.id, "identical pending proposal must not duplicate"
        rows = db.query(ProposedAction).filter(
            ProposedAction.kind == "send_sms",
            ProposedAction.status == "pending").all()
        assert sum(1 for r in rows if (r.payload or {}) == payload) == 1
        assert first.status == "pending"
    finally:
        _cleanup(db, proposal_ids=ids)


def test_create_proposal_rejects_unknown_kind_and_bad_payload():
    db = SessionLocal()
    try:
        with pytest.raises(ValueError):
            create_proposal(db, org_id=1, agent_id="mia", kind="delete_job",
                            title="nope", detail=None, payload={})
        with pytest.raises(ValueError):
            create_proposal(db, org_id=1, agent_id="mia", kind="assign_cleaner",
                            title="nope", detail=None, payload={"job_id": 1})  # no cleaner_id
        with pytest.raises(ValueError):
            create_proposal(db, org_id=1, agent_id="mia", kind="send_sms",
                            title="nope", detail=None, payload={"body": "hi"})  # no target
    finally:
        db.close()


# ── approve → executes through the real assign path ─────────────────────────

def test_approve_assign_cleaner_executes_via_real_path():
    db = SessionLocal()
    c, p, j = _seed_job(db)
    u, crew_id = _seed_cleaner(db)
    prop_ids = []
    try:
        row = create_proposal(db, org_id=1, agent_id="mia", kind="assign_cleaner",
                              title=f"Assign {u.full_name} to {p.name}",
                              detail=None,
                              payload={"job_id": j.id, "cleaner_id": crew_id})
        prop_ids.append(row.id)
        r = client.post(f"/api/ai/proposals/{row.id}/approve")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "executed"
        assert body["result"]["assigned"] == crew_id
        assert body["decided_at"] is not None
        # The Job's assignment actually changed — through update_job, not a
        # raw column write.
        db.expire_all()
        fresh = db.query(Job).filter(Job.id == j.id).first()
        assert [str(x) for x in (fresh.cleaner_ids or [])] == [crew_id]
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c], users=[u],
                 proposal_ids=prop_ids)


def test_approve_non_pending_409_and_dismiss_works():
    db = SessionLocal()
    c, p, j = _seed_job(db)
    u, crew_id = _seed_cleaner(db)
    prop_ids = []
    try:
        row = create_proposal(db, org_id=1, agent_id="mia", kind="assign_cleaner",
                              title="Assign", detail=None,
                              payload={"job_id": j.id, "cleaner_id": crew_id})
        prop_ids.append(row.id)
        assert client.post(f"/api/ai/proposals/{row.id}/approve").status_code == 200
        # Second approval: no longer pending → 409 (and no re-execution).
        assert client.post(f"/api/ai/proposals/{row.id}/approve").status_code == 409
        assert client.post(f"/api/ai/proposals/{row.id}/dismiss").status_code == 409

        other = create_proposal(db, org_id=1, agent_id="mia", kind="send_sms",
                                title="Text", detail=None,
                                payload={"conversation_id": 434343,
                                         "body": f"hi {uuid.uuid4().hex}"})
        prop_ids.append(other.id)
        r = client.post(f"/api/ai/proposals/{other.id}/dismiss")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "dismissed"
        assert body["decided_at"] is not None
        # The master API key resolves to the synthetic admin (id=0, not a
        # users row), which is recorded as NULL — a real JWT user would be
        # recorded by id. Either way the decision itself is stamped.
        assert body["decided_by"] is None
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c], users=[u],
                 proposal_ids=prop_ids)


def test_cross_org_proposal_returns_404():
    db = SessionLocal()
    row = ProposedAction(org_id=OTHER_ORG, agent_id="mia", kind="assign_cleaner",
                         title="Foreign", payload={"job_id": 1, "cleaner_id": "x"},
                         status="pending")
    db.add(row); db.commit(); db.refresh(row)
    try:
        # Same idiom as test_tenancy_scope_job_actions: the master-key caller
        # resolves to the default org, so another org's row must 404 (never a
        # 403, which would confirm the id exists) and never appear in the list.
        assert client.post(f"/api/ai/proposals/{row.id}/approve").status_code == 404
        assert client.post(f"/api/ai/proposals/{row.id}/dismiss").status_code == 404
        listed = client.get("/api/ai/proposals?status=pending")
        assert listed.status_code == 200
        assert row.id not in [x["id"] for x in listed.json()]
    finally:
        _cleanup(db, proposal_ids=[row.id])


# ── propose mode on the EXISTING auto-assign tick ───────────────────────────

def test_propose_mode_tick_writes_proposals_and_does_not_assign():
    db = SessionLocal()
    # Anchor job: the roster is derived from real assignments, so the crew ID
    # must already appear on a (different-day) job to be a candidate.
    u, crew_id = _seed_cleaner(db)
    ac, ap, anchor = _seed_job(db, assigned=[crew_id], days_out=40)
    c, p, j = _seed_job(db, days_out=30)  # unassigned target turnover
    made = []
    try:
        db.query(AppSetting).filter(
            AppSetting.key == "str_auto_assign_mode").delete(synchronize_session=False)
        db.add(AppSetting(key="str_auto_assign_mode", value="propose"))
        db.commit()

        from scheduler import str_turnover_autoassign_tick
        out = str_turnover_autoassign_tick()
        assert out.get("mode") == "propose"
        db.expire_all()
        fresh = db.query(Job).filter(Job.id == j.id).first()
        assert not (fresh.cleaner_ids or []), "propose mode must not assign"
        made = _job_proposal_ids(db, j.id)
        assert len(made) == 1, f"expected exactly one proposal for job {j.id}"
        prop_row = db.get(ProposedAction, made[0])
        assert prop_row.status == "pending"
        assert prop_row.agent_id == "mia"
        assert prop_row.title.startswith("Assign ")
        assert "turnover on" in prop_row.title

        # Re-running the tick is idempotent: the dedupe guard returns the
        # existing pending proposal instead of stacking duplicates.
        str_turnover_autoassign_tick()
        db.expire_all()
        assert _job_proposal_ids(db, j.id) == made
        fresh = db.query(Job).filter(Job.id == j.id).first()
        assert not (fresh.cleaner_ids or [])
    finally:
        _cleanup(db, jobs=[j, anchor], props=[p, ap], clients=[c, ac], users=[u],
                 proposal_ids=made, setting_keys=["str_auto_assign_mode"])


def test_off_mode_tick_skips():
    db = SessionLocal()
    try:
        db.query(AppSetting).filter(
            AppSetting.key.in_(["str_auto_assign_mode",
                                "str_turnover_autoassign_enabled"])).delete(
            synchronize_session=False)
        db.commit()
        from scheduler import str_turnover_autoassign_tick
        assert str_turnover_autoassign_tick() == {"skipped": True}
    finally:
        db.close()


# ── failed execution keeps the row + records the error ──────────────────────

def test_failed_execution_records_error_and_keeps_row(monkeypatch):
    db = SessionLocal()
    c, p, j = _seed_job(db)
    u, crew_id = _seed_cleaner(db)
    prop_ids = []
    try:
        def boom(*args, **kwargs):
            raise RuntimeError("gcal exploded mid-write")
        monkeypatch.setattr("modules.scheduling.router.update_job", boom)

        row = create_proposal(db, org_id=1, agent_id="mia", kind="assign_cleaner",
                              title="Assign", detail=None,
                              payload={"job_id": j.id, "cleaner_id": crew_id})
        prop_ids.append(row.id)
        result = execute_proposal(db, row, None)
        assert result.status == "failed"
        assert "gcal exploded" in (result.result or {}).get("error", "")
        # Row intact, decision stamped, job untouched.
        db.expire_all()
        kept = db.query(ProposedAction).filter(ProposedAction.id == row.id).first()
        assert kept is not None and kept.status == "failed"
        assert kept.decided_at is not None
        fresh = db.query(Job).filter(Job.id == j.id).first()
        assert not (fresh.cleaner_ids or [])
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c], users=[u],
                 proposal_ids=prop_ids)
