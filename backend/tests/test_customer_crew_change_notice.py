"""BB-CUST-04: the customer is told when who's coming CHANGES after booking.

Once a customer is booked in, if the office swaps the crew on their upcoming
visit, services.scheduled_notice.notify_customer_crew_changed texts and emails
them a link to see the new crew and confirm. Gated OFF by its own standing
rule, best-effort, no address/access detail, and no crew names inlined (the
link is the source of truth).

The wiring pins the guards that keep it from firing at the wrong moment: only
on a real crew change to an already-scheduled future visit that still has
somebody on it, never on the first scheduling (that's the booked-in notice),
never on an unrelated edit, and never when the operator unticked "notify".
"""
import uuid
from datetime import date, time
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, Activity
from services import scheduled_notice
from modules.scheduling.router import update_job, JobUpdate
from utils.dates import business_today


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

    def job(c, *, status="scheduled", cleaner_ids=("amy",), when="future"):
        p = Property(client_id=c.id, name="Maple Cottage", address="1 Secret Ln",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        d = business_today() + (date.resolution * 3 if when == "future" else -date.resolution * 3) \
            if status == "scheduled" else None
        j = Job(client_id=c.id, property_id=p.id, title="Visit", job_type="residential",
                scheduled_date=d, start_time=time(9, 0), end_time=time(12, 0),
                status=status, org_id=1, cleaner_ids=[str(x) for x in cleaner_ids])
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

def test_sends_both_channels_when_rule_on(ctx):
    db, client, job = ctx
    j = job(client())
    with patch("services.standing_rules.customer_crew_change_notice_enabled", return_value=True), \
         patch("integrations.twilio_client.send_sms", return_value={"sid": "SM"}) as sms, \
         patch("integrations.email.send_email", return_value={}) as email, \
         patch("services.scheduled_notice._thread_outbound"):
        scheduled_notice.notify_customer_crew_changed(db, j)
    assert sms.call_count == 1 and email.call_count == 1
    # No address on either channel; the link carries who's coming.
    assert "Secret Ln" not in sms.call_args.kwargs["body"]
    assert "Secret Ln" not in email.call_args.kwargs["text_body"]
    db.refresh(j)
    assert f"/job/{j.public_token}" in sms.call_args.kwargs["body"]


def test_silent_when_rule_off(ctx):
    db, client, job = ctx
    j = job(client())
    with patch("services.standing_rules.customer_crew_change_notice_enabled", return_value=False), \
         patch("integrations.twilio_client.send_sms") as sms, \
         patch("integrations.email.send_email") as email:
        scheduled_notice.notify_customer_crew_changed(db, j)
    assert sms.call_count == 0 and email.call_count == 0


# ── wiring in update_job ─────────────────────────────────────────────────────

def test_a_crew_swap_notifies(ctx):
    db, client, job = ctx
    j = job(client(), cleaner_ids=("amy",))
    with patch("services.scheduled_notice.notify_customer_crew_changed") as notice:
        update_job(j.id, JobUpdate(cleaner_ids=["ben"], allow_conflicts=True), db=db, org_id=1)
    assert notice.call_count == 1
    assert notice.call_args.args[1].id == j.id


def test_first_scheduling_does_not_fire_crew_change(ctx):
    # unscheduled (nobody on it) -> scheduled AND a crew assigned in the same
    # save: the crew set genuinely changes ([] -> [amy]), so only the
    # prev_status=="scheduled" guard stops this — that is the booked-in
    # notice's moment, not a crew CHANGE.
    db, client, job = ctx
    j = job(client(), status="unscheduled", cleaner_ids=())
    with patch("services.scheduled_notice.notify_customer_crew_changed") as notice, \
         patch("services.scheduled_notice.notify_customer_scheduled"):
        update_job(j.id, JobUpdate(scheduled_date=str(business_today() + date.resolution * 4),
                                   cleaner_ids=["amy"], allow_conflicts=True), db=db, org_id=1)
    assert notice.call_count == 0


def test_same_crew_does_not_fire(ctx):
    db, client, job = ctx
    j = job(client(), cleaner_ids=("amy",))
    with patch("services.scheduled_notice.notify_customer_crew_changed") as notice:
        # cleaner_ids present in payload but unchanged
        update_job(j.id, JobUpdate(cleaner_ids=["amy"], allow_conflicts=True), db=db, org_id=1)
    assert notice.call_count == 0


def test_removing_everyone_does_not_fire(ctx):
    db, client, job = ctx
    j = job(client(), cleaner_ids=("amy",))
    with patch("services.scheduled_notice.notify_customer_crew_changed") as notice:
        update_job(j.id, JobUpdate(cleaner_ids=[], allow_conflicts=True), db=db, org_id=1)
    assert notice.call_count == 0


def test_notify_customer_false_suppresses(ctx):
    db, client, job = ctx
    j = job(client(), cleaner_ids=("amy",))
    with patch("services.scheduled_notice.notify_customer_crew_changed") as notice:
        update_job(j.id, JobUpdate(cleaner_ids=["ben"], notify_customer=False,
                                   allow_conflicts=True), db=db, org_id=1)
    assert notice.call_count == 0


def test_rule_listed_and_defaults_off(ctx):
    db, _, _ = ctx
    from services.standing_rules import list_rules
    rules = {r["key"]: r for r in list_rules(db)["rules"]}
    assert "customer_crew_change_notice" in rules
    assert rules["customer_crew_change_notice"]["fields"][0]["default"] is False
