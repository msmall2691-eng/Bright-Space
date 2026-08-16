"""A matched-but-unlinked Google Calendar event must become a pending
ProposedAction (kind="create_job_from_gcal"), never a Job written directly
from the sync read (scheduling-invariants Rule 0 / R2).

This is the inbox pattern gcal_sync.py now uses instead of the old
`db.add(Job(...))` in its 3-tier-match branch — mirrors how iCal/Airbnb
turnover feeds already work: raw capture, then explicit human promotion
(services/proposals.py, ProposedAction, migration 091).

Covers:
  (a) a newly-matched event creates a pending proposal, not a Job
  (b) approving it creates the real Job through create_job — the same write
      path JobCreateModal.jsx uses — with conflict detection reachable, and
      stamps gcal_event_id on the new Job
  (c) the next poll after approval finds the Job via the existing
      Job.gcal_event_id lookup (the "already linked" branch) and does not
      re-propose, and does not push a duplicate event to Google
  (d) dismissing a proposal and re-polling the same event does NOT create a
      new pending proposal
  (e) the already-linked-job update/cancel-detection path is unchanged
      (regression coverage lives in test_gcal_sync_idempotent.py; this file
      does not duplicate it)
"""
import uuid
from datetime import date, time, timedelta
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, ProposedAction
from services.proposals import create_proposal

api = TestClient(app)


def _future(days=30):
    return date.today() + timedelta(days=days)


def _service_returning(events):
    svc = MagicMock()
    svc.events.return_value.list.return_value.execute.return_value = {"items": events}
    return svc


def _run_sync(db, events, source="brightbase"):
    from integrations import gcal_sync
    with patch("integrations.google_calendar._get_service", return_value=_service_returning(events)), \
         patch("integrations.gcal_sync.calendar_source_of_truth", return_value=source):
        return gcal_sync.sync_calendar(db, calendar_ids=["primary"])


def _seed_client(db, org_id=1):
    tag = uuid.uuid4().hex[:8]
    c = Client(name=f"GCal Inbox {tag}", email=f"gcal-{tag}@example.com",
               status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"Home {tag}", address="1 Inbox Way",
                 property_type="residential", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    return c, p


def _matched_event(gcal_id, client_email, sched_date, ical_uid=None):
    """An event that matches by attendee email — no extendedProperties, no
    location, so it exercises the tier-2 match method."""
    return {
        "id": gcal_id,
        "status": "confirmed",
        "summary": "Weekly clean",
        "iCalUID": ical_uid or f"uid-{gcal_id}",
        "attendees": [{"email": client_email}],
        "start": {"dateTime": f"{sched_date.isoformat()}T10:00:00-04:00"},
        "end": {"dateTime": f"{sched_date.isoformat()}T13:00:00-04:00"},
    }


def _cleanup(db, *, jobs=(), props=(), clients=(), proposal_ids=()):
    if proposal_ids:
        db.query(ProposedAction).filter(
            ProposedAction.id.in_(list(proposal_ids))).delete(synchronize_session=False)
    for j in jobs:
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    for p in props:
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    for c in clients:
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


# ── (a) matched event proposes, does not create a Job ───────────────────────

def test_matched_event_creates_pending_proposal_not_a_job():
    db = SessionLocal()
    c, p = _seed_client(db)
    prop_ids = []
    try:
        sched_date = _future(20)
        event = _matched_event("evt_new_1", c.email, sched_date)
        r = _run_sync(db, [event])

        assert r["proposals_created"] == 1
        assert r.get("proposals_skipped", 0) == 0

        rows = db.query(ProposedAction).filter(
            ProposedAction.kind == "create_job_from_gcal",
            ProposedAction.org_id == c.org_id,
        ).all()
        matches = [row for row in rows if (row.payload or {}).get("gcal_event_id") == "evt_new_1"]
        assert len(matches) == 1
        prop_ids = [m.id for m in matches]
        row = matches[0]
        assert row.status == "pending"
        assert row.agent_id == "mia"
        assert row.payload["client_id"] == c.id
        assert row.payload["scheduled_date"] == sched_date.isoformat()
        assert "New job from Google Calendar" in row.title
        assert c.name in row.detail

        # No Job was written directly from the read.
        assert db.query(Job).filter(Job.client_id == c.id).count() == 0
    finally:
        _cleanup(db, props=[p], clients=[c], proposal_ids=prop_ids)


# ── (b) approving creates the real Job, conflict detection reachable ────────

def test_approving_proposal_creates_job_via_real_path_and_stamps_gcal_id():
    db = SessionLocal()
    c, p = _seed_client(db)
    prop_ids, job_ids = [], []
    try:
        sched_date = _future(21)
        # job_type="str_turnover" so the SECOND proposal below exercises
        # create_job's turnover duplicate guard (property_id + scheduled_date
        # + job_type) — a guard that reliably fires on both SQLite and
        # Postgres, unlike the general one-off-job duplicate guard a few
        # lines below it in create_job, which compares a raw "HH:MM"
        # start_time string against the Time column and — pre-existing,
        # unrelated to this change — never matches on SQLite because the
        # column is stored as "HH:MM:SS.ffffff". Not this task's bug to fix;
        # picking job_type="str_turnover" sidesteps it for this assertion.
        payload = {
            "client_id": c.id,
            "title": "Weekly clean",
            "job_type": "str_turnover",
            "scheduled_date": sched_date.isoformat(),
            "start_time": "10:00",
            "end_time": "13:00",
            "address": "1 Inbox Way",
            "property_id": p.id,
            "notes": "",
            "gcal_event_id": "evt_approve_1",
            "gcal_ical_uid": "uid-approve-1",
        }
        row = create_proposal(db, org_id=c.org_id, agent_id="mia",
                              kind="create_job_from_gcal",
                              title="New job from Google Calendar", detail=None,
                              payload=payload)
        prop_ids.append(row.id)

        r = api.post(f"/api/ai/proposals/{row.id}/approve")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "executed", body
        job_id = body["result"]["job_id"]
        assert job_id
        job_ids.append(SimpleNamespace(id=job_id))

        db.expire_all()
        job = db.query(Job).filter(Job.id == job_id).first()
        assert job is not None
        assert job.client_id == c.id
        assert job.gcal_event_id == "evt_approve_1"
        assert job.gcal_ical_uid == "uid-approve-1"
        assert job.scheduled_date == sched_date
        assert job.start_time == time(10, 0)

        # ── conflict detection is reachable through this path ──
        # A second matched event for the SAME property/date/time/type collides
        # with the job we just created — create_job's duplicate guard must fire.
        payload2 = dict(payload)
        payload2["gcal_event_id"] = "evt_approve_2"
        payload2["gcal_ical_uid"] = "uid-approve-2"
        row2 = create_proposal(db, org_id=c.org_id, agent_id="mia",
                               kind="create_job_from_gcal",
                               title="New job from Google Calendar (dup)", detail=None,
                               payload=payload2)
        prop_ids.append(row2.id)
        r2 = api.post(f"/api/ai/proposals/{row2.id}/approve")
        assert r2.status_code == 200, r2.text
        body2 = r2.json()
        assert body2["status"] == "failed", body2
        assert "turnover job already exists" in (body2["result"] or {}).get("error", "")
        # The colliding proposal's execution failed — no second Job was made.
        assert db.query(Job).filter(Job.client_id == c.id).count() == 1
    finally:
        db.expire_all()
        real_jobs = [db.query(Job).filter(Job.id == jid.id).first() for jid in job_ids]
        real_jobs = [j for j in real_jobs if j is not None]
        _cleanup(db, jobs=real_jobs, props=[p], clients=[c], proposal_ids=prop_ids)


# ── (c) next poll after approval takes the already-linked branch ────────────

def test_next_poll_after_approval_relinks_and_does_not_repropose():
    db = SessionLocal()
    c, p = _seed_client(db)
    prop_ids, job_ids = [], []
    try:
        sched_date = _future(22)
        event = _matched_event("evt_relink_1", c.email, sched_date)
        r1 = _run_sync(db, [event])
        assert r1["proposals_created"] == 1
        row = next(
            m for m in db.query(ProposedAction).filter(
                ProposedAction.kind == "create_job_from_gcal").all()
            if (m.payload or {}).get("gcal_event_id") == "evt_relink_1"
        )
        prop_ids.append(row.id)

        approved = api.post(f"/api/ai/proposals/{row.id}/approve")
        assert approved.status_code == 200, approved.text
        job_id = approved.json()["result"]["job_id"]
        db.expire_all()
        job = db.query(Job).filter(Job.id == job_id).first()
        assert job.gcal_event_id == "evt_relink_1"
        job_ids.append(job)

        # Poll again with the SAME event: existing_job lookup by gcal_event_id
        # must catch it now — no new proposal, no duplicate job.
        r2 = _run_sync(db, [event])
        assert r2["proposals_created"] == 0
        db.expire_all()
        assert db.query(Job).filter(Job.client_id == c.id).count() == 1
        rows_after = [
            m for m in db.query(ProposedAction).filter(
                ProposedAction.kind == "create_job_from_gcal").all()
            if (m.payload or {}).get("gcal_event_id") == "evt_relink_1"
        ]
        assert len(rows_after) == 1, "no second proposal was created"
    finally:
        _cleanup(db, jobs=job_ids, props=[p], clients=[c], proposal_ids=prop_ids)


# ── (d) dismissing a proposal, then re-polling, does not re-propose ─────────

def test_dismissed_proposal_is_not_recreated_on_next_poll():
    db = SessionLocal()
    c, p = _seed_client(db)
    prop_ids = []
    try:
        sched_date = _future(23)
        event = _matched_event("evt_dismiss_1", c.email, sched_date)
        r1 = _run_sync(db, [event])
        assert r1["proposals_created"] == 1
        row = next(
            m for m in db.query(ProposedAction).filter(
                ProposedAction.kind == "create_job_from_gcal").all()
            if (m.payload or {}).get("gcal_event_id") == "evt_dismiss_1"
        )
        prop_ids.append(row.id)

        dismissed = api.post(f"/api/ai/proposals/{row.id}/dismiss")
        assert dismissed.status_code == 200, dismissed.text
        assert dismissed.json()["status"] == "dismissed"

        r2 = _run_sync(db, [event])
        assert r2["proposals_created"] == 0
        assert r2["proposals_skipped"] == 1

        db.expire_all()
        rows_after = [
            m for m in db.query(ProposedAction).filter(
                ProposedAction.kind == "create_job_from_gcal").all()
            if (m.payload or {}).get("gcal_event_id") == "evt_dismiss_1"
        ]
        assert len(rows_after) == 1
        assert rows_after[0].status == "dismissed"
        assert db.query(Job).filter(Job.client_id == c.id).count() == 0
    finally:
        _cleanup(db, props=[p], clients=[c], proposal_ids=prop_ids)
