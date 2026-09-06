"""The 8pm-in-Maine boundary, for the paths where crossing it was visible.

Timestamps in this schema are UTC (``models._utcnow``). Dates the business
reasons about — ``Job.scheduled_date``, ``Invoice.due_date``, the vetting
cutoff — are business-local. From 8pm Eastern until midnight the UTC date is
already TOMORROW, so anywhere the two met, the answer was a day out for four
hours of every day.

That was not theoretical. It shipped:

  * the vetting gate locked out crew added that evening (fixed in #763);
  * the SMS reminder window slid a day forward, and the body says "tomorrow"
    unconditionally, so a job two days out was texted the wrong day AND marked
    reminded, so the right message never went;
  * dunning chased an invoice on its own due date.

Each test below fixes an instant rather than reading the clock, and asserts
the fixture really does straddle midnight UTC — a test for this that quietly
stops straddling stops testing anything, which is exactly how the original
vetting test passed for weeks before CI happened to run at 00:26 UTC.

``utils.dates.business_date`` is the conversion these paths were missing.
"""
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Invoice, Job, Property
from services import crew_escalation
from services.dunning_service import send_due_dunning
from services.reminder_service import send_due_reminders
from utils.dates import business_date, business_tz

# 8:30pm on 8 Sep 2026 in Maine — which is already the 9th in UTC.
EVENING_UTC = datetime(2026, 9, 9, 0, 30, tzinfo=timezone.utc)
MAINE_DAY = date(2026, 9, 8)


def test_the_fixture_actually_straddles_midnight_utc():
    """Guards every other test in this file.

    If DST rules or the business timezone ever change such that this instant
    no longer falls on a different UTC day, the tests below keep passing while
    testing nothing. This one fails loudly instead.
    """
    assert EVENING_UTC.date() != MAINE_DAY, "no longer straddles — retune the fixture"
    assert EVENING_UTC.astimezone(business_tz()).date() == MAINE_DAY
    assert business_date(EVENING_UTC) == MAINE_DAY


@pytest.fixture
def made():
    ids = {"clients": [], "properties": [], "jobs": [], "invoices": []}
    yield ids
    db = SessionLocal()
    db.query(Invoice).filter(Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _client(db, ids, *, phone="+12075550123", email="evening@example.com"):
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Evening {tag}", status="active", org_id=1,
               phone=phone, email=email)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    return c


# ── The uncovered-job horizon ───────────────────────────────────────────────

def test_the_escalation_horizon_starts_today_in_maine_not_tomorrow_in_utc():
    """_horizon's own docstring says it is deliberately inclusive of today.

    Taking the UTC date is what broke that: after 8pm the window started
    tomorrow and ran a day long, so today's uncovered job — the most urgent
    case there is — fell out, and jobs a day beyond the intended horizon fell
    in. In `auto` mode that second half posts real work to the crew board.
    """
    start, end = crew_escalation._horizon(EVENING_UTC, 48)
    assert start == MAINE_DAY, "today in Maine, not tomorrow in UTC"
    assert end == MAINE_DAY + timedelta(days=2)


# ── Customer SMS reminders ──────────────────────────────────────────────────

def test_a_job_two_days_out_is_not_texted_tomorrow_in_the_evening(made):
    """The one that reached customers.

    build_reminder_body says "tomorrow" with no conditional, and the sender
    sets sms_reminder_sent, so a wrongly-early text is not merely early — it
    is the ONLY message that customer gets about that cleaning.
    """
    db = SessionLocal()
    try:
        c = _client(db, made)
        p = Property(client_id=c.id, name="1 Evening Rd", address="1 Evening Rd", org_id=1)
        db.add(p); db.commit(); db.refresh(p); made["properties"].append(p.id)

        def _job_on(d):
            j = Job(client_id=c.id, property_id=p.id, job_type="residential",
                    title="Clean", status="scheduled", scheduled_date=d,
                    sms_reminder_sent=False, skip_sms_reminder=False, org_id=1)
            db.add(j); db.commit(); db.refresh(j)
            made["jobs"].append(j.id)
            return j

        tomorrow = _job_on(MAINE_DAY + timedelta(days=1))
        day_after = _job_on(MAINE_DAY + timedelta(days=2))

        with patch("services.reminder_service.send_sms",
                   return_value={"sid": "SM-test"}) as sms:
            send_due_reminders(db, lead_hours=24, now=EVENING_UTC)

        db.refresh(tomorrow); db.refresh(day_after)
        assert day_after.sms_reminder_sent is False, \
            "a job two days out must not be told it is happening tomorrow"
        assert tomorrow.sms_reminder_sent is True, \
            "and the genuine next-day reminder must still go"
        assert sms.call_count == 1
        assert "tomorrow" in sms.call_args.kwargs["body"]
    finally:
        db.close()


# ── Overdue-invoice dunning ─────────────────────────────────────────────────

def test_an_invoice_is_not_chased_on_its_own_due_date(made):
    db = SessionLocal()
    try:
        c = _client(db, made)

        def _invoice(due):
            inv = Invoice(client_id=c.id, org_id=1, status="sent",
                          due_date=due.isoformat(), items=[], subtotal=250.0,
                          tax=0.0, total=250.0, dunning_stage=0)
            db.add(inv); db.commit(); db.refresh(inv)
            made["invoices"].append(inv.id)
            return inv

        due_today = _invoice(MAINE_DAY)
        due_yesterday = _invoice(MAINE_DAY - timedelta(days=1))

        with patch("services.dunning_service.send_email") as mail:
            send_due_dunning(db, now=EVENING_UTC)

        db.refresh(due_today); db.refresh(due_yesterday)
        assert due_today.dunning_stage == 0, \
            "nobody is overdue on the day their invoice is due"
        assert due_today.status == "sent", "and it must not be flipped to overdue"
        assert due_yesterday.dunning_stage == 1, \
            "a genuinely late invoice is still chased"
        assert mail.call_count == 1
    finally:
        db.close()
