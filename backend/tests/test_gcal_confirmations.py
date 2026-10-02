"""Capturing a customer's Google Calendar RSVP as a visit confirmation.

The read is on-demand and folds an *accepted* invite into the same
Job.customer_confirmed_at the tap-to-confirm link writes. A decline never
touches the Job (scheduling-invariants R7), an already-confirmed or
never-invited job never calls Google at all, and any Google error fails open.
"""
import uuid
from datetime import time, timedelta, datetime, timezone
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, Activity
from services.gcal_confirmations import maybe_capture_customer_rsvp
from utils.dates import business_today


@pytest.fixture
def job_ids():
    ids = {"jobs": [], "properties": [], "clients": []}
    yield ids
    db = SessionLocal()
    db.query(Activity).filter(Activity.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _make_job(job_ids, *, email="cust@example.com", invited=True, confirmed=False,
              event_id="evt-1", status="scheduled"):
    db = SessionLocal()
    c = Client(name=f"Cust {uuid.uuid4().hex[:6]}", email=email, status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); job_ids["clients"].append(c.id)
    p = Property(client_id=c.id, name="1 Elm", address="1 Elm", org_id=1)
    db.add(p); db.commit(); db.refresh(p); job_ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Clean",
            scheduled_date=business_today() + timedelta(days=1),
            start_time=time(10, 0), end_time=time(12, 0), status=status, org_id=1,
            gcal_event_id=event_id, calendar_invite_sent=invited,
            customer_confirmed_at=datetime.now(timezone.utc) if confirmed else None)
    db.add(j); db.commit(); db.refresh(j); job_ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _reload(jid):
    db = SessionLocal()
    j = db.query(Job).options().filter(Job.id == jid).first()
    # keep the session open via a fresh query in the caller; return a detached snapshot
    confirmed = j.customer_confirmed_at
    db.close()
    return confirmed


def _event(response_status, email="cust@example.com", **attendee_extra):
    att = {"email": email, "responseStatus": response_status, **attendee_extra}
    return {"status": "confirmed", "attendees": [
        {"email": "office@maineclean.co", "responseStatus": "accepted", "self": True},
        att,
    ]}


def _run(jid):
    db = SessionLocal()
    try:
        job = db.query(Job).filter(Job.id == jid).first()
        return maybe_capture_customer_rsvp(db, job), (job.customer_confirmed_at is not None)
    finally:
        db.close()


def test_accepted_rsvp_confirms_the_visit(job_ids):
    jid = _make_job(job_ids)
    with patch("integrations.google_calendar.is_configured", return_value=True), \
         patch("integrations.google_calendar.get_event", return_value=_event("accepted")):
        changed, confirmed = _run(jid)
    assert changed is True and confirmed is True
    # It logged the confirmation with the calendar actor.
    db = SessionLocal()
    acts = db.query(Activity).filter(Activity.job_id == jid,
                                     Activity.activity_type == "job_customer_confirmed").all()
    assert len(acts) == 1 and acts[0].actor == "google_calendar"
    db.close()


def test_declined_rsvp_does_not_touch_the_job(job_ids):
    jid = _make_job(job_ids)
    with patch("integrations.google_calendar.is_configured", return_value=True), \
         patch("integrations.google_calendar.get_event", return_value=_event("declined")):
        changed, confirmed = _run(jid)
    assert changed is False and confirmed is False


def test_tentative_rsvp_is_not_a_confirmation(job_ids):
    jid = _make_job(job_ids)
    with patch("integrations.google_calendar.is_configured", return_value=True), \
         patch("integrations.google_calendar.get_event", return_value=_event("tentative")):
        changed, _ = _run(jid)
    assert changed is False


def test_already_confirmed_never_calls_google(job_ids):
    jid = _make_job(job_ids, confirmed=True)
    with patch("integrations.google_calendar.get_event") as ge:
        changed, confirmed = _run(jid)
    assert changed is False and confirmed is True
    ge.assert_not_called()


def test_uninvited_job_never_calls_google(job_ids):
    jid = _make_job(job_ids, invited=False)
    with patch("integrations.google_calendar.get_event") as ge:
        changed, _ = _run(jid)
    assert changed is False
    ge.assert_not_called()


def test_google_error_fails_open(job_ids):
    jid = _make_job(job_ids)
    with patch("integrations.google_calendar.is_configured", return_value=True), \
         patch("integrations.google_calendar.get_event", side_effect=RuntimeError("boom")):
        changed, confirmed = _run(jid)
    assert changed is False and confirmed is False


def test_our_own_calendar_entry_is_not_the_customer(job_ids):
    # An attendee that matches the client's email but is our own account
    # (self/organizer) must not count as the customer accepting.
    jid = _make_job(job_ids)
    ev = {"status": "confirmed", "attendees": [
        {"email": "cust@example.com", "responseStatus": "accepted", "organizer": True}]}
    with patch("integrations.google_calendar.is_configured", return_value=True), \
         patch("integrations.google_calendar.get_event", return_value=ev):
        changed, _ = _run(jid)
    assert changed is False
