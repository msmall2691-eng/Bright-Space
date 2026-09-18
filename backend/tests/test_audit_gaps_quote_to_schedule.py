"""Gaps between "quote accepted" and "job on the calendar" — the handoffs an
audit found silently dropped.

  1. The quotes list carries `job_id` / `job_scheduled_date` (batch-loaded, no
     N+1) so a quote auto-converted on accept — job exists, no date yet — reads
     as "needs scheduling" rather than "Scheduled".
  2. Accepting a quote alerts the owner on every channel: email to the owner
     alert address (falling back to the SMTP sender), an SMS to the owner
     alert phone, and a staff web push — all from the background task.
  3. /api/intake/submit sends the same owner SMS + email that /booking/submit
     does, via the shared services.owner_alerts; a deduped replay stays silent.
  4. /api/schedule/week carries `unscheduled` for office roles (never crew).
  5. Blank quote terms fall back to the estimate / non-binding default on the
     public page and the email; owner-set text wins.
  6. A quote-sourced job that gets a date sends the customer's dated notice;
     the customer self-schedule path sends exactly one dated confirmation.
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Property, Quote, Job, Activity, AppSetting, LeadIntake, Opportunity,
)
from modules.auth.router import current_org_id, get_current_user
from ratelimit import limiter
from utils.dates import business_today


# ── shared fixtures ───────────────────────────────────────────────────────────

@pytest.fixture
def ctx():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Gap Test {tag}", first_name="Gap", email=f"gap-{tag}@example.com",
               phone="207-555-0142", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Gap House", address=f"{tag} Gap Rd",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    db.rollback()
    jids = [r[0] for r in db.query(Job.id).filter(Job.client_id == c.id).all()]
    if jids:
        db.query(Activity).filter(Activity.job_id.in_(jids)).delete(synchronize_session=False)
    db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture(autouse=True)
def _quiet_integrations():
    with patch("integrations.google_calendar.is_configured", return_value=False), \
         patch("integrations.email.send_email", return_value=None), \
         patch("integrations.twilio_client.send_sms", return_value={"sid": "SM-test"}):
        yield


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    limiter.reset()
    yield
    limiter.reset()


def _mk_quote(db, c, *, status="sent", property_id=None):
    tok = uuid.uuid4().hex[:12]
    q = Quote(client_id=c.id, org_id=1, quote_number=f"QT-GAP-{tok[:5]}", title="T",
              service_type="residential", address="1 St", notes="", items=[],
              subtotal=150, tax_rate=0, tax=0, discount=0, total=150, status=status,
              public_token=tok, property_id=property_id,
              valid_until=date.today() + timedelta(days=30))
    db.add(q); db.commit(); db.refresh(q)
    return q


class _Role:
    def __init__(self, role, uid=9970, cleaner_id=None):
        self.id, self.org_id, self.role = uid, 1, role
        self.status, self.active = "active", True
        self.email = f"{role}-{uid}@example.com"
        self.full_name = f"{role.title()} {uid}"
        self.cleaner_id = cleaner_id


@pytest.fixture
def as_role():
    def _as(role, **kw):
        user = _Role(role, **kw)
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[current_org_id] = lambda: 1
        return TestClient(app)
    yield _as
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _set_setting(db, key, value):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    prev = row.value if row else None
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))
    db.commit()
    return prev


# ── 1. quotes list carries the job's date ─────────────────────────────────────

def test_quotes_list_carries_job_id_and_date_without_n_plus_one(ctx):
    from modules.quoting.router import list_quotes, _job_fields_for_quotes
    db, c, p = ctx
    dated = _mk_quote(db, c, status="converted", property_id=p.id)
    dateless = _mk_quote(db, c, status="converted", property_id=p.id)
    plain = _mk_quote(db, c, status="sent", property_id=p.id)
    db.add(Job(client_id=c.id, property_id=p.id, org_id=1, quote_id=dated.id, title="D",
               scheduled_date=date(2026, 10, 2), start_time=time(9, 0), end_time=time(12, 0),
               status="scheduled"))
    db.add(Job(client_id=c.id, property_id=p.id, org_id=1, quote_id=dateless.id, title="U",
               status="unscheduled"))
    db.commit()

    rows = {r["id"]: r for r in list_quotes(db=db, client_id=c.id, status=None, limit=100, offset=0)}
    assert rows[dated.id]["job_id"] and rows[dated.id]["job_scheduled_date"] == "2026-10-02"
    assert rows[dateless.id]["job_id"] and rows[dateless.id]["job_scheduled_date"] is None
    assert rows[plain.id]["job_id"] is None and rows[plain.id]["job_scheduled_date"] is None

    # One query for the whole page, not one per quote.
    from sqlalchemy import event
    from database.db import engine
    count = {"n": 0}

    def _count(*a, **k):
        count["n"] += 1
    event.listen(engine, "before_cursor_execute", _count)
    try:
        _job_fields_for_quotes(db, [dated, dateless, plain])
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    assert count["n"] == 1


def test_quote_details_job_reports_missing_date(ctx):
    from modules.quoting.router import get_quote_details, public_accept_quote, PublicAcceptRequest
    db, c, p = ctx
    q = _mk_quote(db, c, property_id=p.id)
    public_accept_quote(q.public_token, PublicAcceptRequest(name="Gap"), db=db)
    d = get_quote_details(q.id, db=db, org_id=1)
    assert d["status"] == "converted"
    assert d["job"]["id"] == d["job_id"]
    assert d["job"]["scheduled_date"] is None and d["job_scheduled_date"] is None


# ── 2. accept fans out to the owner ──────────────────────────────────────────

def _run_accept_with_spies(db, q, *, owner_email=None, owner_phone=None):
    """Accept via the public link with a BackgroundTasks collector, run the
    task, and return what reached each channel."""
    from fastapi import BackgroundTasks
    from modules.quoting.router import public_accept_quote, PublicAcceptRequest
    bt = BackgroundTasks()
    sent_mail, sent_sms = [], []
    env = {}
    if owner_email:
        env["OWNER_ALERT_EMAIL"] = owner_email
    if owner_phone:
        env["OWNER_ALERT_PHONE"] = owner_phone
    with patch.dict("os.environ", env, clear=False), \
         patch("integrations.email._load_smtp_creds",
               return_value={"from_email": "smtp-sender@example.com", "from_name": "Co",
                             "smtp_user": "u", "smtp_pass": "p", "smtp_host": "h", "smtp_port": 587}), \
         patch("integrations.email.send_email", side_effect=lambda **k: sent_mail.append(k)), \
         patch("integrations.twilio_client.send_sms",
               side_effect=lambda **k: sent_sms.append(k) or {"sid": "x"}), \
         patch("services.push_service.notify_staff", return_value=0) as push:
        public_accept_quote(q.public_token, PublicAcceptRequest(name="Megan Q"),
                            background_tasks=bt, db=db)
        assert bt.tasks, "notifications must be backgrounded, not inline"
        for t in bt.tasks:
            t.func(*t.args, **t.kwargs)
    return sent_mail, sent_sms, push


def test_accept_emails_owner_alert_address_and_texts_and_pushes(ctx):
    db, c, p = ctx
    q = _mk_quote(db, c, property_id=p.id)
    mail, sms, push = _run_accept_with_spies(db, q, owner_email="owner@example.com",
                                             owner_phone="+12075550199")
    owner_mail = [m for m in mail if m["to"] == "owner@example.com"]
    assert owner_mail and q.quote_number in owner_mail[0]["subject"]
    assert f"/quotes/{q.id}?book=1" in owner_mail[0]["text_body"]
    assert not [m for m in mail if m["to"] == "smtp-sender@example.com"]
    assert len(sms) == 1 and sms[0]["to"] == "+12075550199"
    body = sms[0]["body"]
    assert q.quote_number in body and "Megan Q" in body and "$150.00" in body and "?book=1" in body
    assert push.called
    assert push.call_args.kwargs["tag"] == f"quote-accepted-{q.id}"
    assert push.call_args.kwargs["category"] == "quotes"


def test_accept_falls_back_to_smtp_sender_and_skips_sms_when_unset(ctx, monkeypatch):
    monkeypatch.delenv("OWNER_ALERT_EMAIL", raising=False)
    monkeypatch.delenv("OWNER_ALERT_PHONE", raising=False)
    db, c, p = ctx
    prev_e = _set_setting(db, "owner_alert_email", "")
    prev_p = _set_setting(db, "owner_alert_phone", "")
    try:
        q = _mk_quote(db, c, property_id=p.id)
        mail, sms, push = _run_accept_with_spies(db, q)
        assert [m for m in mail if m["to"] == "smtp-sender@example.com"]
        assert sms == []
        assert push.called
    finally:
        _set_setting(db, "owner_alert_email", prev_e or "")
        _set_setting(db, "owner_alert_phone", prev_p or "")


def test_accept_notification_failure_never_reaches_the_customer(ctx):
    from fastapi import BackgroundTasks
    from modules.quoting.router import public_accept_quote, PublicAcceptRequest
    db, c, p = ctx
    q = _mk_quote(db, c, property_id=p.id)
    bt = BackgroundTasks()
    with patch.dict("os.environ", {"OWNER_ALERT_PHONE": "+12075550199"}), \
         patch("integrations.twilio_client.send_sms", side_effect=RuntimeError("twilio down")), \
         patch("integrations.email.send_email", side_effect=RuntimeError("smtp down")), \
         patch("services.push_service.notify_staff", side_effect=RuntimeError("push down")):
        out = public_accept_quote(q.public_token, PublicAcceptRequest(), background_tasks=bt, db=db)
        for t in bt.tasks:
            t.func(*t.args, **t.kwargs)  # must not raise
    assert out["status"] == "converted"


# ── 3. intake/submit alerts the owner like booking/submit ────────────────────

def _cleanup_intake(intake_id):
    db = SessionLocal()
    try:
        db.query(LeadIntake).filter(LeadIntake.id == intake_id).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_intake_submit_texts_and_emails_the_owner():
    client = TestClient(app)
    sms, mail = MagicMock(return_value=True), MagicMock(return_value=True)
    body = {"name": "Ira Intake", "email": f"ira-{uuid.uuid4().hex[:6]}@example.com",
            "phone": "+12075550177", "address": "3 Elm St", "city": "Camden",
            "service_type": "residential", "message": "Two bathrooms please",
            "idempotency_key": str(uuid.uuid4())}
    with patch("services.owner_alerts.send_owner_sms", sms), \
         patch("services.owner_alerts.send_owner_email", mail):
        r = client.post("/api/intake/submit", json=body)
    assert r.status_code == 201, r.text
    intake_id = r.json()["intake_id"]
    try:
        assert sms.called and mail.called
        assert "Ira Intake" in sms.call_args.args[1]
        assert "Ira Intake" in mail.call_args.kwargs["subject"]
        assert any("Two bathrooms please" in str(l) for l in mail.call_args.kwargs["lines"])
        # A pure replay (same idempotency key, nothing new) alerts nobody again.
        sms.reset_mock(); mail.reset_mock()
        with patch("services.owner_alerts.send_owner_sms", sms), \
             patch("services.owner_alerts.send_owner_email", mail):
            r2 = client.post("/api/intake/submit", json=body)
        assert r2.status_code == 201 and r2.json()["intake_id"] == intake_id
        assert not sms.called and not mail.called
    finally:
        _cleanup_intake(intake_id)


def test_intake_owner_alert_failure_does_not_fail_the_submit():
    client = TestClient(app)
    body = {"name": "Fail Safe", "email": f"fs-{uuid.uuid4().hex[:6]}@example.com",
            "phone": "+12075550178", "service_type": "residential",
            "idempotency_key": str(uuid.uuid4())}
    with patch("services.owner_alerts.send_owner_sms", side_effect=RuntimeError("boom")), \
         patch("services.owner_alerts.send_owner_email", side_effect=RuntimeError("boom")):
        r = client.post("/api/intake/submit", json=body)
    assert r.status_code == 201, r.text
    _cleanup_intake(r.json()["intake_id"])


def test_booking_router_still_patchable_through_the_shared_service():
    # The booking wrappers delegate to services.owner_alerts — same lookup rules.
    from modules.booking import router as booking_router
    from services import owner_alerts
    db = SessionLocal()
    try:
        with patch.dict("os.environ", {"OWNER_ALERT_EMAIL": "env-owner@example.com"}):
            prev = _set_setting(db, "owner_alert_email", "")
            try:
                assert booking_router._owner_notify_setting(db, "owner_alert_email", "OWNER_ALERT_EMAIL") \
                    == owner_alerts.owner_alert_email(db) == "env-owner@example.com"
            finally:
                _set_setting(db, "owner_alert_email", prev or "")
    finally:
        db.close()


# ── 4. schedule/week carries date-less jobs for the office only ──────────────

def test_week_payload_lists_unscheduled_jobs_for_office_not_crew(ctx, as_role):
    db, c, p = ctx
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Needs a date", status="unscheduled")
    done = Job(client_id=c.id, property_id=p.id, org_id=1, title="Old", status="cancelled")
    db.add_all([j, done]); db.commit(); db.refresh(j)
    today = business_today().isoformat()
    url = f"/api/schedule/week?scheduled_date_from={today}&scheduled_date_to={today}"

    office = as_role("admin").get(url)
    assert office.status_code == 200, office.text
    ids = [r["id"] for r in office.json()["unscheduled"]]
    assert j.id in ids and done.id not in ids
    row = next(r for r in office.json()["unscheduled"] if r["id"] == j.id)
    assert row["client_name"] == c.name and row["scheduled_date"] is None
    # Date-less jobs are still not in the ranged lists.
    assert j.id not in [r["id"] for r in office.json()["jobs"]]

    crew = as_role("cleaner", uid=9971, cleaner_id="CT-GAP").get(url)
    assert crew.status_code == 200
    assert crew.json()["unscheduled"] == []


# ── 5. quote terms default ───────────────────────────────────────────────────

def test_blank_quote_terms_fall_back_to_the_estimate_language(ctx, monkeypatch):
    from modules.settings.router import quote_terms_text, DEFAULT_QUOTE_TERMS
    from modules.quoting.router import public_view_quote
    db, c, p = ctx
    prev = _set_setting(db, "quote_terms", "")
    try:
        assert quote_terms_text(db) == DEFAULT_QUOTE_TERMS
        assert "good-faith estimate" in DEFAULT_QUOTE_TERMS
        assert "no contract" in DEFAULT_QUOTE_TERMS
        q = _mk_quote(db, c, property_id=p.id)
        with patch("services.push_service.notify_staff", return_value=0):
            page = public_view_quote(q.public_token, db=db)
        assert page["terms"] == DEFAULT_QUOTE_TERMS

        _set_setting(db, "quote_terms", "Owner's own terms.")
        assert quote_terms_text(db) == "Owner's own terms."
        page = public_view_quote(q.public_token, db=db)
        assert page["terms"] == "Owner's own terms."
    finally:
        _set_setting(db, "quote_terms", prev or "")


def test_quote_email_service_uses_the_same_terms_default(monkeypatch):
    from modules.settings.router import DEFAULT_QUOTE_TERMS
    from services import quote_email_service as qes
    db = SessionLocal()
    prev = _set_setting(db, "quote_terms", "")
    db.close()
    try:
        assert qes.QuoteEmailService._terms_setting() == DEFAULT_QUOTE_TERMS
    finally:
        db = SessionLocal(); _set_setting(db, "quote_terms", prev or ""); db.close()


# ── 6. dated customer notice on the quote-sourced job ────────────────────────

def test_quote_sourced_job_created_with_a_date_sends_the_dated_notice(ctx):
    from modules.scheduling.router import create_job, JobCreate
    db, c, p = ctx
    q = _mk_quote(db, c, status="accepted", property_id=p.id)
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice:
        create_job(JobCreate(client_id=c.id, title="From quote", property_id=p.id,
                             scheduled_date="2026-10-05", start_time="09:00", end_time="12:00",
                             quote_id=q.id), db=db, org_id=1)
    assert notice.call_count == 1
    assert notice.call_args.args[1].quote_id == q.id


def test_dating_the_auto_converted_job_sends_the_dated_notice(ctx):
    from modules.quoting.router import public_accept_quote, PublicAcceptRequest
    from modules.scheduling.router import update_job, JobUpdate
    db, c, p = ctx
    q = _mk_quote(db, c, property_id=p.id)
    public_accept_quote(q.public_token, PublicAcceptRequest(name="Gap"), db=db)
    job = db.query(Job).filter(Job.quote_id == q.id).one()
    assert job.scheduled_date is None
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice:
        update_job(job.id, JobUpdate(scheduled_date="2026-10-06", start_time="09:00",
                                     end_time="12:00", allow_conflicts=True), db=db, org_id=1)
    assert notice.call_count == 1


def test_self_schedule_sends_exactly_one_dated_customer_confirmation(ctx):
    from modules.quoting.router import public_schedule_quote, PublicScheduleRequest
    db, c, p = ctx
    q = _mk_quote(db, c, property_id=p.id)
    d = business_today() + timedelta(days=3)
    while d.weekday() == 6:
        d += timedelta(days=1)
    customer_mail = []
    with patch("services.scheduled_notice.notify_customer_scheduled") as notice, \
         patch("integrations.email._load_smtp_creds",
               return_value={"from_email": "co@example.com", "from_name": "Co", "smtp_user": "u",
                             "smtp_pass": "p", "smtp_host": "h", "smtp_port": 587}), \
         patch("integrations.email.send_email", side_effect=lambda **k: customer_mail.append(k)):
        out = public_schedule_quote(q.public_token, PublicScheduleRequest(
            date=d.isoformat(), window="morning", name="Megan", email="megan@example.com"), db=db)
    assert out["scheduled"] is True
    # The job write was told to stay quiet — this path sends its own.
    assert notice.call_count == 0
    to_customer = [m for m in customer_mail if m["to"] == "megan@example.com"]
    assert len(to_customer) == 1
    assert out["date_label"] in to_customer[0]["subject"]
    assert "reach out shortly to schedule" not in to_customer[0]["text_body"]
