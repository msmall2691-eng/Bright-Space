"""Autopilot level 2 — the approval queue fills itself.

What's pinned here is the judgement, not the prose the model writes:

  - WHO gets drafted for. A customer who texted four hours ago and got no
    answer; a quote that's been out three days. Not someone the owner already
    replied to, not a snoozed thread, not an email thread (which `send_sms`
    has no way to execute), not a quote with no phone number on the client.
  - THAT NOTHING SENDS. Every producer parks a pending ProposedAction. The
    only thing that sends is a human tapping approve, which was already true
    and stays true.
  - THAT IT DOESN'T REPEAT ITSELF. A source she hasn't dealt with is not
    re-drafted tomorrow, and one she dismissed doesn't come straight back —
    create_proposal's own dedupe compares whole payloads and cannot see this,
    because no two drafts of the same reply are byte-identical.
  - THAT A DRAFT CAN BE EDITED before approval, and that the edit is confined
    to the message body — not to which conversation it goes to.
  - THAT IT COSTS NOTHING when it's switched off or there's no model.

The drafters themselves (modules/ai/router) are stubbed in most of these:
they're already covered where they live, they cost money, and a test that
asserts on generated prose is a test that fails on a Tuesday for no reason.
The last test in the file calls them for real with no model configured, so a
drifted signature can't hide behind the stubs.
"""
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (AppSetting, Client, Conversation, ProposedAction,
                             Quote)
from services import autopilot_drafts as ad

client = TestClient(app)


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _seed_client(db, org_id=1, *, phone="+12075550101"):
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Drafty {tag}", status="active", phone=phone,
               email=f"drafty-{tag}@example.com", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _seed_conversation(db, client_row, *, hours_waiting=6, channel="sms",
                       replied=False, status="open", snoozed_hours=None,
                       org_id=1):
    inbound = _now() - timedelta(hours=hours_waiting)
    conv = Conversation(
        client_id=client_row.id, channel=channel, status=status,
        subject="Can you clean Saturday?", org_id=org_id,
        last_message_at=inbound, last_inbound_at=inbound,
        last_outbound_at=(inbound + timedelta(minutes=5)) if replied else None,
        snoozed_until=(_now() + timedelta(hours=snoozed_hours))
        if snoozed_hours else None,
    )
    db.add(conv); db.commit(); db.refresh(conv)
    return conv


def _seed_quote(db, client_row, *, days_quiet=5, status="sent", org_id=1):
    tag = uuid.uuid4().hex[:8]
    q = Quote(client_id=client_row.id, quote_number=f"Q-{tag}",
              title="Deep clean", status=status, total=450.0,
              valid_until=date.today() + timedelta(days=10),
              sent_at=datetime.now(timezone.utc) - timedelta(days=days_quiet),
              org_id=org_id)
    db.add(q); db.commit(); db.refresh(q)
    return q


def _cleanup(db, *, clients=(), convs=(), quotes=(), proposal_ids=(),
             setting_keys=()):
    if proposal_ids:
        db.query(ProposedAction).filter(
            ProposedAction.id.in_(list(proposal_ids))).delete(synchronize_session=False)
    for q in quotes:
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
    for c in convs:
        db.query(Conversation).filter(Conversation.id == c.id).delete(synchronize_session=False)
    for c in clients:
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    for k in setting_keys:
        db.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture
def drafting(monkeypatch):
    """Stub the two drafters and the model check, and record what was asked
    for. The prompts are exercised where they live; here they'd only buy a
    flaky assertion on generated prose."""
    calls = {"reply": [], "nudge": []}

    def fake_reply(db, conv):
        calls["reply"].append(conv.id)
        return f"Hi! Yes, Saturday works — draft for conversation {conv.id}."

    def fake_nudge(db, org_id, quote):
        calls["nudge"].append(quote.id)
        return f"Just checking in on quote {quote.quote_number}!"

    monkeypatch.setattr(ad, "_draft_waiting_reply", fake_reply)
    monkeypatch.setattr(ad, "_draft_quote_nudge", fake_nudge)
    monkeypatch.setattr("modules.ai.router._anthropic_client", lambda: object())
    return calls


# ── who gets drafted for ────────────────────────────────────────────────────

def test_drafts_a_reply_for_a_customer_left_waiting(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=6)
    ids = []
    try:
        result = ad.draft_followups(db, 1)
        ids = result["proposed"]
        mine = [db.query(ProposedAction).get(i) for i in ids]
        mine = [p for p in mine if (p.payload or {}).get("conversation_id") == conv.id]
        assert len(mine) == 1, "the waiting conversation should produce one draft"

        p = mine[0]
        assert p.status == "pending", "drafting must never send"
        assert p.kind == "send_sms"
        assert p.agent_id == ad.AGENT_ID
        assert p.payload["body"].endswith(f"conversation {conv.id}.")
        assert p.payload["source"] == f"waiting_reply:{conv.id}"
        assert "waiting 6h" in p.title
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_skips_a_conversation_the_owner_already_answered(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=6, replied=True)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        assert drafting["reply"] == [], "nobody is waiting — she already replied"
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_skips_a_conversation_still_inside_the_grace_window(drafting):
    # Two hours is her having coffee, not a customer being ignored.
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=2)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        assert drafting["reply"] == []
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_skips_a_thread_a_human_deliberately_snoozed(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=48, snoozed_hours=24)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        assert drafting["reply"] == [], "snoozing is a human saying 'not yet'"
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_skips_an_email_thread_it_could_not_send_on(drafting):
    # send_sms is the only message kind the approval gate can execute. An email
    # draft would queue a row that fails the moment she approves it.
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=8, channel="email")
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        assert drafting["reply"] == []
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_drafts_a_nudge_for_a_quote_gone_quiet(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    q = _seed_quote(db, c, days_quiet=5)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        mine = [p for p in (db.query(ProposedAction).get(i) for i in ids)
                if (p.payload or {}).get("source") == f"quote_nudge:{q.id}"]
        assert len(mine) == 1
        assert mine[0].status == "pending"
        assert mine[0].payload["client_id"] == c.id
        assert q.quote_number in mine[0].payload["body"]
    finally:
        _cleanup(db, proposal_ids=ids, quotes=[q], clients=[c])


def test_skips_a_quote_still_fresh_and_one_already_answered(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    fresh = _seed_quote(db, c, days_quiet=1)
    accepted = _seed_quote(db, c, days_quiet=30, status="accepted")
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        assert drafting["nudge"] == [], \
            "a one-day-old quote isn't quiet, and an accepted one got its answer"
    finally:
        _cleanup(db, proposal_ids=ids, quotes=[fresh, accepted], clients=[c])


def test_skips_a_quote_whose_client_has_no_phone(drafting):
    # The send path resolves the number off the Client row, so this would only
    # ever produce a proposal that fails on approval.
    db = SessionLocal()
    c = _seed_client(db, phone="")
    q = _seed_quote(db, c, days_quiet=9)
    ids = []
    try:
        result = ad.draft_followups(db, 1)
        ids = result["proposed"]
        assert drafting["nudge"] == []
        assert result["skipped"].get("no_phone") == 1
    finally:
        _cleanup(db, proposal_ids=ids, quotes=[q], clients=[c])


# ── it doesn't repeat itself ────────────────────────────────────────────────

def test_running_twice_does_not_draft_the_same_thing_again(drafting):
    # The bodies differ between runs, so create_proposal's whole-payload dedupe
    # can't catch this — the `source` key is what does.
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=7)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        assert drafting["reply"] == [conv.id]

        second = ad.draft_followups(db, 1)
        ids += second["proposed"]
        assert drafting["reply"] == [conv.id], "must not re-draft, or re-pay for, the same thread"
        assert not [i for i in second["proposed"]
                    if (db.query(ProposedAction).get(i).payload or {})
                    .get("source") == f"waiting_reply:{conv.id}"]
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_a_dismissed_draft_does_not_come_straight_back(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=7)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        row = db.query(ProposedAction).get(ids[0])
        row.status = "dismissed"
        row.decided_at = _now()
        db.commit()

        again = ad.draft_followups(db, 1)
        ids += again["proposed"]
        assert drafting["reply"] == [conv.id], \
            "'no thanks' should hold for the cooldown, not until the next page load"
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_a_draft_dismissed_long_ago_is_offered_again(drafting):
    # The cooldown is a cooldown, not a permanent blocklist: a customer still
    # waiting a week later should surface again.
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=200)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        row = db.query(ProposedAction).get(ids[0])
        row.status = "dismissed"
        row.decided_at = _now() - timedelta(hours=ad._COOLDOWN_HOURS + 2)
        db.commit()

        again = ad.draft_followups(db, 1)
        ids += again["proposed"]
        assert drafting["reply"] == [conv.id, conv.id]
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_one_run_is_capped(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    convs = [_seed_conversation(db, c, hours_waiting=10 + n)
             for n in range(ad._MAX_PER_RUN + 3)]
    ids = []
    try:
        result = ad.draft_followups(db, 1)
        ids = result["proposed"]
        assert len(ids) == ad._MAX_PER_RUN
        assert len(drafting["reply"]) == ad._MAX_PER_RUN, \
            "the cap must stop the model calls, not just the rows"
        assert result["skipped"].get("over_limit") == 3
    finally:
        _cleanup(db, proposal_ids=ids, convs=convs, clients=[c])


# ── it costs nothing when it shouldn't run ──────────────────────────────────

def test_no_model_configured_drafts_nothing(monkeypatch):
    # The drafters fall back to a generic "thanks, we're on it" template. That's
    # fine as one holding reply; six identical form letters in an approval
    # queue is not what this is for.
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    monkeypatch.setattr("modules.ai.router._anthropic_client", lambda: None)
    try:
        result = ad.draft_followups(db, 1)
        assert result["proposed"] == []
        assert result["reason"] == "no_model"
    finally:
        _cleanup(db, convs=[conv], clients=[c])


def test_endpoint_is_a_no_op_when_switched_off(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    try:
        db.add(AppSetting(key="autopilot_drafts_enabled", value="false"))
        db.commit()
        res = client.post("/api/ai/autopilot/draft-followups")
        assert res.status_code == 200
        body = res.json()
        assert body["enabled"] is False and body["proposed"] == []
        assert drafting["reply"] == [], "off must mean no completions are paid for"
    finally:
        _cleanup(db, convs=[conv], clients=[c],
                 setting_keys=["autopilot_drafts_enabled"])


def test_drafting_is_on_by_default(drafting):
    # Nothing here acts on the business — it writes drafts into a queue that
    # still needs a tap — and the point is that the work is waiting when she
    # opens Home. A default of off would mean she never sees the feature.
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    ids = []
    try:
        res = client.post("/api/ai/autopilot/draft-followups")
        assert res.status_code == 200
        body = res.json()
        assert body["enabled"] is True
        ids = body["proposed"]
        assert drafting["reply"] == [conv.id]
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


# ── a draft you can't edit is take-it-or-leave-it ───────────────────────────

def test_the_drafted_message_can_be_edited_before_approving(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        pid = ids[0]
        res = client.patch(f"/api/ai/proposals/{pid}",
                           json={"payload": {"body": "Saturday at 9 works — see you then!"}})
        assert res.status_code == 200
        assert res.json()["payload"]["body"] == "Saturday at 9 works — see you then!"
        assert res.json()["status"] == "pending", "editing is not deciding"

        db.expire_all()
        row = db.query(ProposedAction).get(pid)
        assert row.payload["body"] == "Saturday at 9 works — see you then!"
        assert row.payload["conversation_id"] == conv.id, "the target must survive the edit"
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_editing_cannot_redirect_the_message(drafting):
    # The title and detail on screen say who this goes to. Letting an edit move
    # it to another conversation would make the screen a lie.
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        res = client.patch(f"/api/ai/proposals/{ids[0]}",
                           json={"payload": {"conversation_id": 987654}})
        assert res.status_code == 422
        db.expire_all()
        assert db.query(ProposedAction).get(ids[0]).payload["conversation_id"] == conv.id
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_an_empty_body_is_refused_rather_than_saved(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        res = client.patch(f"/api/ai/proposals/{ids[0]}",
                           json={"payload": {"body": "   "}})
        assert res.status_code == 422
        db.expire_all()
        assert db.query(ProposedAction).get(ids[0]).payload["body"].strip()
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_a_decided_proposal_can_no_longer_be_edited(drafting):
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    ids = []
    try:
        ids = ad.draft_followups(db, 1)["proposed"]
        row = db.query(ProposedAction).get(ids[0])
        row.status = "executed"
        db.commit()
        res = client.patch(f"/api/ai/proposals/{ids[0]}",
                           json={"payload": {"body": "too late"}})
        assert res.status_code == 409, \
            "once it ran, the payload is the record of what was actually sent"
    finally:
        _cleanup(db, proposal_ids=ids, convs=[conv], clients=[c])


def test_a_structural_proposal_kind_is_not_editable():
    from services.proposals import create_proposal
    db = SessionLocal()
    ids = []
    try:
        row = create_proposal(db, org_id=1, agent_id="mia", kind="assign_cleaner",
                              title="Assign Ana", detail=None,
                              payload={"job_id": 424243, "cleaner_id": "crew-x"})
        ids.append(row.id)
        res = client.patch(f"/api/ai/proposals/{row.id}",
                           json={"payload": {"cleaner_id": "crew-y"}})
        assert res.status_code == 422, \
            "which cleaner IS the proposal — swapping it is a different decision"
    finally:
        _cleanup(db, proposal_ids=ids)


def test_editing_another_orgs_proposal_is_a_404():
    from services.proposals import create_proposal
    db = SessionLocal()
    ids = []
    try:
        row = create_proposal(db, org_id=99999, agent_id="scout", kind="send_sms",
                              title="Text someone else's customer", detail=None,
                              payload={"client_id": 1, "body": "hi"})
        ids.append(row.id)
        res = client.patch(f"/api/ai/proposals/{row.id}",
                           json={"payload": {"body": "changed"}})
        assert res.status_code == 404, "cross-org must 404, never 403 (id oracle)"
    finally:
        _cleanup(db, proposal_ids=ids)


# ── the drafters are called for real, not just mocked ───────────────────────

def test_the_drafter_calls_actually_line_up_with_the_endpoints(monkeypatch):
    """The producers reuse modules/ai/router's draft endpoints as plain
    functions. Every other test here stubs them, so a signature that drifted
    (a renamed request model, a new required dependency) would fail only in
    production. This calls both for real with no model configured, which walks
    the same argument path and lands in each drafter's deterministic fallback —
    no completion is paid for, but a wrong call still raises."""
    monkeypatch.setattr("modules.ai.router._anthropic_client", lambda: None)
    db = SessionLocal()
    c = _seed_client(db)
    conv = _seed_conversation(db, c, hours_waiting=9)
    q = _seed_quote(db, c, days_quiet=5)
    try:
        assert ad._draft_waiting_reply(db, conv), "reply drafter returned nothing"
        assert ad._draft_quote_nudge(db, 1, q), "quote drafter returned nothing"
    finally:
        _cleanup(db, quotes=[q], convs=[conv], clients=[c])
