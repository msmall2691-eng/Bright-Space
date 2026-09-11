"""BB-CUST-01: the customer is told once their cleaning is booked in.

A website booking got a "we'll confirm within a business day" receipt and then
nothing until the 24h reminder — even though the office scheduled them days
earlier. When a job becomes scheduled, services.scheduled_notice sends a text
and an email with the date, time, and the confirm link (where who's-coming and
reschedule live). It is gated OFF by default, best-effort on both channels, and
carries no address or access detail.

These pin: it fires only when the rule is on and the job is actually scheduled;
it reaches both channels; it never inlines an address; and the schedule write
sites (update_job on the transition into scheduled; create_job for a direct,
non-quote scheduled job) call it — but not on an unrelated edit, and not when
the operator unticked "notify customer".
"""
import uuid
from datetime import date, time
from unittest.mock import patch, MagicMock

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, Activity
from services import scheduled_notice
from modules.scheduling.router import update_job, create_job, JobUpdate, JobCreate


@pytest.fixture
def ctx():
    db = SessionLocal()
    made = {"clients": []}

    def client(*, phone="207-555-0100", email="cust@example.com"):
        c = Client(name=f"Casey {uuid.uuid4().hex[:5]}", first_name="Casey",
                   status="active", org_id=1, phone=phone, email=email)
        db.add(c); db.commit(); db.refresh(c)
        made["clients"].append(c.id)
        return c

    def job(c, *, status="scheduled", scheduled=True):
        p = Property(client_id=c.id, name="Maple Cottage", address="1 Secret Ln",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        j = Job(client_id=c.id, property_id=p.id, title="Visit", job_type="residential",
                scheduled_date=date(2026, 9, 15) if scheduled else None,
                start_time=time(9, 0), end_time=time(12, 0), status=status, org_id=1)
        db.add(j); db.commit(); db.refresh(j)
        return j

    yield db, client, job

    db.rollback()
    cids = made["clients"] or [0]
    jids = [r[0] for r in db.query(Job.id).filter(Job.client_id.in_(cids)).all()]
    if jids:
        db.query(Activity).filter(Activity.job_id.in_(jids)).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(cids)).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture(autouse=True)
def _no_gcal():
    with patch("integrations.google_calendar.is_configured", return_value=False):
        yield


# ── the service ──────────────────────────────────────────────────────────────

def test_sends_both_channels_when_enabled(ctx):
    db, client, job = ctx
    c = client()
    j = job(c)
    with patch("services.standing_rules.customer_scheduled_notice_enabled", return_value=True), \
         patch("integrations.twilio_client.send_sms", return_value={"sid": "SM1"}) as sms, \
         patch("integrations.email.send_email", return_value={"ok": True}) as email, \
         patch("services.scheduled_notice._thread_outbound"):
        scheduled_notice.notify_customer_scheduled(db, j)

    assert sms.call_count == 1
    assert email.call_count == 1
    # The link points at the confirm page, and the job now has a token.
    db.refresh(j)
    assert j.public_token
    assert f"/job/{j.public_token}" in sms.call_args.kwargs["body"]
    # No address / access detail on either channel.
    assert "Secret Ln" not in sms.call_args.kwargs["body"]
    assert "Secret Ln" not in email.call_args.kwargs["html_body"]
    assert "Secret Ln" not in email.call_args.kwargs["text_body"]


def test_silent_when_rule_is_off(ctx):
    db, client, job = ctx
    j = job(client())
    with patch("services.standing_rules.customer_scheduled_notice_enabled", return_value=False), \
         patch("integrations.twilio_client.send_sms") as sms, \
         patch("integrations.email.send_email") as email:
        scheduled_notice.notify_customer_scheduled(db, j)
    assert sms.call_count == 0 and email.call_count == 0


def test_email_only_when_no_phone(ctx):
    db, client, job = ctx
    j = job(client(phone=None))
    with patch("services.standing_rules.customer_scheduled_notice_enabled", return_value=True), \
         patch("integrations.twilio_client.send_sms") as sms, \
         patch("integrations.email.send_email", return_value={}) as email:
        scheduled_notice.notify_customer_scheduled(db, j)
    assert sms.call_count == 0
    assert email.call_count == 1


def test_noop_for_a_job_that_is_not_scheduled(ctx):
    db, client, job = ctx
    j = job(client(), scheduled=False)   # no date yet
    with patch("services.standing_rules.customer_scheduled_notice_enabled", return_value=True), \
         patch("integrations.twilio_client.send_sms") as sms, \
         patch("integrations.email.send_email") as email:
        scheduled_notice.notify_customer_scheduled(db, j)
    assert sms.call_count == 0 and email.call_count == 0


# ── wiring: update_job transition into scheduled ──────────────────────────────

def test_scheduling_an_unscheduled_job_notifies(ctx):
    db, client, job = ctx
    j = job(client(), status="unscheduled", scheduled=False)
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice:
        update_job(j.id, JobUpdate(scheduled_date="2026-09-20", allow_conflicts=True),
                   db=db, org_id=1)
    assert notice.call_count == 1
    assert notice.call_args.args[1].id == j.id


def test_unrelated_edit_does_not_notify(ctx):
    db, client, job = ctx
    j = job(client())   # already scheduled
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice:
        update_job(j.id, JobUpdate(notes="left a note", allow_conflicts=True),
                   db=db, org_id=1)
    assert notice.call_count == 0


def test_notify_customer_false_suppresses(ctx):
    db, client, job = ctx
    j = job(client(), status="unscheduled", scheduled=False)
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice:
        update_job(j.id, JobUpdate(scheduled_date="2026-09-20", notify_customer=False,
                                   allow_conflicts=True), db=db, org_id=1)
    assert notice.call_count == 0


# ── wiring: create_job for a direct scheduled job ─────────────────────────────

def test_creating_a_scheduled_job_notifies(ctx):
    db, client, job = ctx
    c = client()
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice:
        create_job(JobCreate(client_id=c.id, title="Visit", scheduled_date="2026-09-20",
                             start_time="09:00", end_time="12:00"),
                   db=db, org_id=1)
    assert notice.call_count == 1
    assert notice.call_args.args[1].client_id == c.id


def test_creating_with_notify_customer_false_suppresses(ctx):
    # notify_customer was declared only on JobUpdate, so a create body asking to
    # stay quiet was silently dropped by pydantic and the notice went out anyway.
    # With the field on JobCreate, False must actually suppress at creation time.
    db, client, job = ctx
    c = client()
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice:
        create_job(JobCreate(client_id=c.id, title="Visit", scheduled_date="2026-09-20",
                             start_time="09:00", end_time="12:00", notify_customer=False),
                   db=db, org_id=1)
    assert notice.call_count == 0


# ── the standing rule is visible + off by default ─────────────────────────────

def test_rule_is_listed_and_defaults_off(ctx):
    db, _, _ = ctx
    from services.standing_rules import list_rules
    rules = {r["key"]: r for r in list_rules(db)["rules"]}
    assert "customer_scheduled_notice" in rules
    field = rules["customer_scheduled_notice"]["fields"][0]
    assert field["key"] == "customer_scheduled_notice_enabled"
    assert field["default"] is False
