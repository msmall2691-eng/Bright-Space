"""Quote follow-up + conversion traceability (April audit §3/§5.3/§6/§10).

Covers:
- convert-to-job stamps quote.converted_at and status='converted'
- intake→quote stamps intake.converted_quote_id
- GET /follow-ups buckets stale sent/viewed quotes and excludes resolved ones
- re-sending an already-sent quote records follow_up_sent_at without resetting
  the original status/sent_at
"""
import pytest
from datetime import datetime, timedelta
from unittest.mock import patch

from database.db import SessionLocal
from database.models import Client, Quote, QuoteEmail, Property, LeadIntake
from modules.quoting.router import (
    convert_quote_to_job, quotes_needing_follow_up, send_quote, QuoteSendRequest,
)
from modules.intake.router import convert_intake_to_quote


def _mk_quote(db, client_id, number, **kw):
    q = Quote(client_id=client_id, quote_number=number, title="T",
              service_type="residential", address="1 St", notes="", items=[],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100,
              status=kw.pop("status", "draft"), **kw)
    db.add(q); db.commit(); db.refresh(q)
    return q


@pytest.fixture
def client_ctx():
    db = SessionLocal()
    c = Client(name="FollowUp Test", email="cust@example.com", phone="+12075551212", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.rollback()
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_convert_to_job_stamps_converted_at(client_ctx):
    db, c = client_ctx
    q = _mk_quote(db, c.id, "QT-CONV-1", status="accepted")
    out = convert_quote_to_job(q.id, db=db)
    assert out["quote_id"] == q.id
    db.refresh(q)
    assert q.status == "converted" and q.converted_at is not None


def test_intake_convert_stamps_converted_quote_id():
    db = SessionLocal()
    intake = LeadIntake(name="Lead Person", email="lead@example.com",
                        phone="+12075559999", service_type="residential",
                        estimate_min=100, estimate_max=200, status="new")
    db.add(intake); db.commit(); db.refresh(intake)
    try:
        result = convert_intake_to_quote(intake.id, db=db)
        db.refresh(intake)
        assert intake.status == "quoted"
        assert intake.converted_quote_id == result["id"]
    finally:
        db.query(Quote).filter(Quote.id == intake.converted_quote_id).delete(synchronize_session=False)
        if intake.client_id:
            db.query(Client).filter(Client.id == intake.client_id).delete(synchronize_session=False)
        db.query(LeadIntake).filter(LeadIntake.id == intake.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_follow_up_report_buckets_and_exclusions(client_ctx):
    db, c = client_ctx
    now = datetime.now()
    # Stale sent, never viewed -> sent_not_viewed
    q_sent = _mk_quote(db, c.id, "QT-FU-SENT", status="sent",
                       sent_at=now - timedelta(hours=72))
    # Viewed long ago, not accepted -> viewed_not_accepted
    q_viewed = _mk_quote(db, c.id, "QT-FU-VIEW", status="viewed",
                         sent_at=now - timedelta(hours=80), viewed_at=now - timedelta(hours=30))
    # Recently sent -> excluded (within window)
    _mk_quote(db, c.id, "QT-FU-FRESH", status="sent", sent_at=now - timedelta(hours=2))
    # Accepted -> excluded (status filter)
    _mk_quote(db, c.id, "QT-FU-ACC", status="accepted", sent_at=now - timedelta(hours=99))

    rows = quotes_needing_follow_up(db=db, sent_hours=48, viewed_hours=24)
    by_num = {r["quote_number"]: r for r in rows if r["client_id"] == c.id}

    assert by_num["QT-FU-SENT"]["follow_up_reason"] == "sent_not_viewed"
    assert by_num["QT-FU-VIEW"]["follow_up_reason"] == "viewed_not_accepted"
    assert "QT-FU-FRESH" not in by_num
    assert "QT-FU-ACC" not in by_num
    assert by_num["QT-FU-SENT"]["hours_waiting"] >= 48


def test_follow_up_suppressed_after_recent_nudge(client_ctx):
    db, c = client_ctx
    now = datetime.now()
    _mk_quote(db, c.id, "QT-FU-NUDGED", status="sent",
              sent_at=now - timedelta(hours=72), follow_up_sent_at=now - timedelta(hours=1))
    rows = quotes_needing_follow_up(db=db, sent_hours=48, viewed_hours=24)
    nums = {r["quote_number"] for r in rows if r["client_id"] == c.id}
    assert "QT-FU-NUDGED" not in nums  # nudged within the 48h window -> suppressed


def test_resend_records_follow_up_without_resetting_sent(client_ctx):
    db, c = client_ctx
    original_sent = datetime.now() - timedelta(hours=50)
    q = _mk_quote(db, c.id, "QT-FU-RESEND", status="sent", sent_at=original_sent)
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "fu-1"}
        send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    db.refresh(q)
    assert q.status == "sent"                       # not flipped/reset
    assert q.follow_up_sent_at is not None          # nudge recorded
    # original sent_at preserved (sent->accepted clock intact)
    assert abs((q.sent_at.replace(tzinfo=None) - original_sent).total_seconds()) < 2
    db.query(QuoteEmail).filter_by(quote_id=q.id).delete(synchronize_session=False)
    db.commit()
