"""Autopilot level 3 — the standing rules.

Two things are under test, and they're different in kind.

THE CATALOGUE is a presentation layer over settings the ticks already read.
What matters is that it can't lie: it reports the value actually in force, a
rule the deployment has hard-disabled reads as blocked rather than as a plain
ON, an unknown key is refused instead of silently dropped, and a value outside
a rule's bounds is refused instead of quietly clamped to something she didn't
type. It must also never become a second source of truth — writing through the
catalogue and reading through the tick's own accessor must agree.

THE NEW RULE — "offer a job to the crew when nobody's on it" — actually acts,
so what's pinned is when it does and doesn't: only scheduled jobs, only inside
the window, only ones with nobody assigned and not already open; 'propose'
writes a proposal and opens NOTHING; 'auto' opens through the same executor an
approved proposal uses; and one pass is capped.
"""
import uuid
from datetime import date, datetime, time, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import AppSetting, Client, Job, ProposedAction, Property
from services import crew_escalation as ce
from services import standing_rules as sr

client = TestClient(app)


def _seed_job(db, *, days_out=1, assigned=None, status="scheduled",
              open_for_claims=False, org_id=1):
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"RuleOwner {tag}", status="active",
               email=f"rule-{tag}@example.com", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"Lakeshore {tag}", address="9 Rule Rd",
                 property_type="residential", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title=f"Clean {tag}",
            job_type="residential", scheduled_date=date.today() + timedelta(days=days_out),
            start_time=time(10, 0), end_time=time(13, 0), status=status,
            cleaner_ids=assigned, open_for_claims=open_for_claims, org_id=org_id)
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def _cleanup(db, *, jobs=(), props=(), clients=(), proposal_ids=(), setting_keys=()):
    if proposal_ids:
        db.query(ProposedAction).filter(
            ProposedAction.id.in_(list(proposal_ids))).delete(synchronize_session=False)
    for j in jobs:
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    for p in props:
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    for c in clients:
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    for k in setting_keys:
        db.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    db.commit(); db.close()


def _rule(payload, key):
    return next(r for r in payload["rules"] if r["key"] == key)


def _field(rule, key):
    return next(f for f in rule["fields"] if f["key"] == key)


# ── the catalogue reports what is actually in force ─────────────────────────

def test_every_rule_is_renderable():
    # The panel renders straight from this list, so a rule with a field type it
    # doesn't know how to draw would ship as a rule with no control at all.
    db = SessionLocal()
    try:
        for rule in sr.list_rules(db)["rules"]:
            assert rule["title"] and rule["summary"], rule["key"]
            assert rule["fields"], rule["key"]
            for f in rule["fields"]:
                assert f["type"] in sr.FIELD_TYPES, f
                assert f["label"], f
                if f["type"] == "choice":
                    assert f["choices"], f
                    assert f["value"] in {c["value"] for c in f["choices"]}, f
                if f["type"] == "number":
                    assert f["min"] <= f["value"] <= f["max"], f
    finally:
        db.close()


def test_a_saved_value_is_what_comes_back():
    db = SessionLocal()
    try:
        sr.save_rules(db, {"crew_escalation_hours": 72})
        after = _field(_rule(sr.list_rules(db), "crew_escalation"),
                       "crew_escalation_hours")
        assert after["value"] == 72
    finally:
        _cleanup(db, setting_keys=["crew_escalation_hours"])


def test_the_catalogue_and_the_tick_read_the_same_value():
    # The whole point of routing rule settings through the existing app_setting
    # keys: the catalogue must never become a second source of truth that the
    # thing actually running the rule doesn't consult.
    db = SessionLocal()
    try:
        sr.save_rules(db, {"crew_escalation_mode": "auto",
                           "crew_escalation_hours": 96,
                           "job_sms_reminder_lead_hours": 12})
        assert sr.crew_escalation_mode(db) == "auto"
        assert sr.crew_escalation_hours(db) == 96
        assert sr.reminder_lead_hours(db) == 12

        from services.reminder_service import _lead_hours
        assert _lead_hours(db) == 12, "the reminder service must see her setting"
    finally:
        _cleanup(db, setting_keys=["crew_escalation_mode", "crew_escalation_hours",
                                   "job_sms_reminder_lead_hours"])


def test_a_rule_the_deployment_switched_off_says_so(monkeypatch):
    # A truthy DB setting reading as a plain ON while an env flag holds the
    # tick off is a real bug this repo already hit once — she'd only find out
    # when a customer said they never got the text.
    monkeypatch.setenv("JOB_SMS_REMINDERS_ENABLED", "0")
    db = SessionLocal()
    try:
        sr.save_rules(db, {"job_sms_reminders_enabled": True})
        rule = _rule(sr.list_rules(db), "customer_reminder")
        assert rule["blocked"] is True
        assert "deploy layer" in rule["blocked_reason"]
        # Her setting is kept, not overwritten — it takes effect when lifted.
        assert _field(rule, "job_sms_reminders_enabled")["value"] is True
    finally:
        _cleanup(db, setting_keys=["job_sms_reminders_enabled"])


def test_a_rule_with_no_env_gate_is_never_blocked():
    db = SessionLocal()
    try:
        assert _rule(sr.list_rules(db), "crew_escalation")["blocked"] is False
    finally:
        db.close()


# ── saving refuses rather than guesses ──────────────────────────────────────

def test_an_unknown_setting_is_refused_not_dropped():
    res = client.post("/api/settings/rules",
                      json={"settings": {"delete_everything": True}})
    assert res.status_code == 422
    assert "delete_everything" in res.json()["detail"]


def test_a_value_outside_the_rules_bounds_is_refused_not_clamped():
    # Clamping would save something other than what she typed, and a lead time
    # is a real behaviour change she wouldn't see happen.
    db = SessionLocal()
    try:
        res = client.post("/api/settings/rules",
                          json={"settings": {"job_sms_reminder_lead_hours": 100000}})
        assert res.status_code == 422
        assert sr.reminder_lead_hours(db) == 24, "nothing should have been written"
    finally:
        db.close()


def test_an_invalid_mode_is_refused():
    res = client.post("/api/settings/rules",
                      json={"settings": {"crew_escalation_mode": "yolo"}})
    assert res.status_code == 422


def test_saving_one_rule_leaves_the_others_alone():
    db = SessionLocal()
    try:
        sr.save_rules(db, {"crew_escalation_mode": "auto"})
        sr.save_rules(db, {"crew_escalation_hours": 60})
        assert sr.crew_escalation_mode(db) == "auto"
        assert sr.crew_escalation_hours(db) == 60
    finally:
        _cleanup(db, setting_keys=["crew_escalation_mode", "crew_escalation_hours"])


def test_the_endpoint_returns_the_refreshed_catalogue():
    db = SessionLocal()
    try:
        res = client.post("/api/settings/rules",
                          json={"settings": {"crew_escalation_hours": 36}})
        assert res.status_code == 200
        assert _field(_rule(res.json(), "crew_escalation"),
                      "crew_escalation_hours")["value"] == 36
    finally:
        _cleanup(db, setting_keys=["crew_escalation_hours"])


# ── the reminder lead time falls back the way it used to ────────────────────

def test_lead_hours_still_honours_the_env_var_until_she_sets_one(monkeypatch):
    monkeypatch.setenv("JOB_SMS_REMINDER_LEAD_HOURS", "6")
    db = SessionLocal()
    try:
        assert sr.reminder_lead_hours(db) == 6, \
            "an existing deployment must keep its configured value"
        sr.save_rules(db, {"job_sms_reminder_lead_hours": 48})
        assert sr.reminder_lead_hours(db) == 48, "her setting wins over the env"
    finally:
        _cleanup(db, setting_keys=["job_sms_reminder_lead_hours"])


def test_a_nonsense_env_value_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("JOB_SMS_REMINDER_LEAD_HOURS", "soon")
    db = SessionLocal()
    try:
        assert sr.reminder_lead_hours(db) == 24
    finally:
        db.close()


# ── who gets offered to the crew ────────────────────────────────────────────

def test_finds_a_job_with_nobody_on_it_inside_the_window():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    try:
        found = ce.find_uncovered(db, hours=48)
        assert j.id in [x.id for x in found]
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c])


def test_ignores_a_job_that_already_has_a_cleaner():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1, assigned=["crew-1"])
    try:
        assert j.id not in [x.id for x in ce.find_uncovered(db, hours=48)]
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c])


def test_ignores_a_job_already_open_to_the_crew():
    # Re-opening an open job is a no-op write and a duplicate row on Home.
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1, open_for_claims=True)
    try:
        assert j.id not in [x.id for x in ce.find_uncovered(db, hours=48)]
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c])


def test_ignores_a_job_beyond_the_window():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=20)
    try:
        assert j.id not in [x.id for x in ce.find_uncovered(db, hours=48)]
        assert j.id in [x.id for x in ce.find_uncovered(db, hours=24 * 30)]
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c])


def test_ignores_a_cancelled_or_completed_job():
    db = SessionLocal()
    c1, p1, cancelled = _seed_job(db, days_out=1, status="cancelled")
    c2, p2, done = _seed_job(db, days_out=1, status="completed")
    try:
        ids = [x.id for x in ce.find_uncovered(db, hours=48)]
        assert cancelled.id not in ids and done.id not in ids
    finally:
        _cleanup(db, jobs=[cancelled, done], props=[p1, p2], clients=[c1, c2])


def test_includes_a_job_later_today():
    # The most urgent case there is — excluding the current day to dodge a
    # partial-day edge would skip exactly the job that needs someone today.
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=0)
    try:
        assert j.id in [x.id for x in ce.find_uncovered(db, hours=48)]
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c])


# ── propose vs auto ─────────────────────────────────────────────────────────

def test_propose_mode_queues_and_opens_nothing():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    ids = []
    try:
        result = ce.escalate_uncovered_jobs(db, mode="propose", hours=48)
        ids = result["proposed"]
        mine = [r for r in (db.query(ProposedAction).get(i) for i in ids)
                if (r.payload or {}).get("job_id") == j.id]
        assert len(mine) == 1
        assert mine[0].kind == "open_to_crew" and mine[0].status == "pending"
        assert result["opened"] == []

        db.expire_all()
        assert db.query(Job).get(j.id).open_for_claims is False, \
            "proposing must not open the job"
    finally:
        _cleanup(db, proposal_ids=ids, jobs=[j], props=[p], clients=[c])


def test_auto_mode_opens_the_job_and_queues_nothing():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    try:
        result = ce.escalate_uncovered_jobs(db, mode="auto", hours=48)
        assert j.id in result["opened"]
        assert result["proposed"] == []
        db.expire_all()
        assert db.query(Job).get(j.id).open_for_claims is True
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c])


def test_off_mode_does_nothing_at_all():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    try:
        result = ce.escalate_uncovered_jobs(db, mode="off", hours=48)
        assert result["proposed"] == [] and result["opened"] == []
        db.expire_all()
        assert db.query(Job).get(j.id).open_for_claims is False
    finally:
        _cleanup(db, jobs=[j], props=[p], clients=[c])


def test_running_twice_does_not_queue_the_same_job_twice():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    ids = []
    try:
        ids = ce.escalate_uncovered_jobs(db, mode="propose", hours=48)["proposed"]
        second = ce.escalate_uncovered_jobs(db, mode="propose", hours=48)
        ids += second["proposed"]

        rows = [r for r in db.query(ProposedAction).filter(
            ProposedAction.kind == "open_to_crew").all()
            if (r.payload or {}).get("job_id") == j.id]
        assert len(rows) == 1, "one job, one pending offer"
        # And the SECOND pass must not report it as newly proposed — otherwise
        # the tick logs ten new proposals every six hours for the same ten
        # untouched jobs, and the cap gets spent on rows already in the queue.
        assert j.id not in [
            (db.query(ProposedAction).get(i).payload or {}).get("job_id")
            for i in second["proposed"]]
        assert second["skipped"].get("already_proposed") == 1
    finally:
        _cleanup(db, proposal_ids=ids, jobs=[j], props=[p], clients=[c])


def test_one_pass_is_capped():
    # A week nobody staffed shouldn't dump the whole backlog onto the crew's
    # board — or onto Home — in one tick.
    db = SessionLocal()
    seeded = [_seed_job(db, days_out=1) for _ in range(ce._MAX_PER_RUN + 2)]
    jobs = [s[2] for s in seeded]
    ids = []
    try:
        result = ce.escalate_uncovered_jobs(db, mode="propose", hours=48)
        ids = result["proposed"]
        assert len(ids) == ce._MAX_PER_RUN
        assert result["skipped"].get("over_limit") == 2
    finally:
        _cleanup(db, proposal_ids=ids, jobs=jobs,
                 props=[s[1] for s in seeded], clients=[s[0] for s in seeded])


# ── approving the proposal ──────────────────────────────────────────────────

def test_approving_opens_the_job_through_the_real_write_path():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    ids = []
    try:
        ids = ce.escalate_uncovered_jobs(db, mode="propose", hours=48)["proposed"]
        pid = next(i for i in ids
                   if (db.query(ProposedAction).get(i).payload or {}).get("job_id") == j.id)
        res = client.post(f"/api/ai/proposals/{pid}/approve")
        assert res.status_code == 200
        assert res.json()["status"] == "executed"

        db.expire_all()
        assert db.query(Job).get(j.id).open_for_claims is True
        # Opening is an offer, not an assignment — a standing rule must never
        # put someone's name on a job by itself.
        assert not (db.query(Job).get(j.id).cleaner_ids or [])
    finally:
        _cleanup(db, proposal_ids=ids, jobs=[j], props=[p], clients=[c])


def test_dismissing_leaves_the_job_closed():
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    ids = []
    try:
        ids = ce.escalate_uncovered_jobs(db, mode="propose", hours=48)["proposed"]
        pid = next(i for i in ids
                   if (db.query(ProposedAction).get(i).payload or {}).get("job_id") == j.id)
        assert client.post(f"/api/ai/proposals/{pid}/dismiss").status_code == 200
        db.expire_all()
        assert db.query(Job).get(j.id).open_for_claims is False
    finally:
        _cleanup(db, proposal_ids=ids, jobs=[j], props=[p], clients=[c])


def test_an_open_to_crew_proposal_is_not_editable():
    # Which job IS the proposal — swapping it is a different decision, and the
    # title on screen names the house.
    db = SessionLocal()
    c, p, j = _seed_job(db, days_out=1)
    ids = []
    try:
        ids = ce.escalate_uncovered_jobs(db, mode="propose", hours=48)["proposed"]
        res = client.patch(f"/api/ai/proposals/{ids[0]}",
                           json={"payload": {"job_id": 999999}})
        assert res.status_code == 422
    finally:
        _cleanup(db, proposal_ids=ids, jobs=[j], props=[p], clients=[c])


def test_a_proposal_without_a_job_is_refused_at_create_time():
    from services.proposals import create_proposal
    db = SessionLocal()
    try:
        with pytest.raises(ValueError):
            create_proposal(db, org_id=1, agent_id="mia", kind="open_to_crew",
                            title="Open something", detail=None, payload={})
    finally:
        db.close()


# ── the tick that carries the rule ──────────────────────────────────────────

def test_the_tick_runs_the_rule_and_survives_its_failure(monkeypatch):
    """The rule rides schedule_audit_tick rather than adding one (R1). It must
    be self-gated there, and a failure inside it must not take the duplicate
    audit down with it — that audit is the tick's original job."""
    import scheduler

    calls = []
    monkeypatch.setattr("services.crew_escalation.escalate_uncovered_jobs",
                        lambda db, **kw: calls.append(kw) or {"proposed": []})

    db = SessionLocal()
    try:
        sr.save_rules(db, {"crew_escalation_mode": "off"})
        scheduler.schedule_audit_tick()
        assert calls == [], "off must not even reach the rule"

        sr.save_rules(db, {"crew_escalation_mode": "propose",
                           "crew_escalation_hours": 30})
        scheduler.schedule_audit_tick()
        assert calls == [{"mode": "propose", "hours": 30}]

        def boom(db, **kw):
            raise RuntimeError("escalation exploded")
        monkeypatch.setattr("services.crew_escalation.escalate_uncovered_jobs", boom)
        out = scheduler.schedule_audit_tick()
        assert "error" not in out, "the duplicate audit must still have run"
    finally:
        _cleanup(db, setting_keys=["crew_escalation_mode", "crew_escalation_hours"])


def test_the_escalation_window_default_is_a_day():
    """Owner's call (Aug 2026): 24 hours, not the 48 it shipped with.

    Pinned rather than left implicit because the default is what actually runs
    until someone opens Settings — and every other test in this file passes
    `hours=` explicitly, so a changed default would otherwise slip through
    green."""
    db = SessionLocal()
    try:
        assert sr.crew_escalation_hours(db) == 24
        assert sr._FIELDS["crew_escalation_hours"]["min"] <= 24
    finally:
        db.close()
