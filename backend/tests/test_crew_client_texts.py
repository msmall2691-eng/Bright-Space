"""Structured client texts (crew → customer, no numbers on crew phones).

The owner's updated rule: crew never see the customer's number; they send
TEMPLATED texts from the business line. Under test: my-day carries no
client_phone (only the can_text_client flag); sends are assigned-only and
day-gated (on-the-way = day of, tomorrow = day before); one send per (job,
template); the personal line rides inside the template; the SMS goes
through the normal comms path (Twilio mocked) and lands on the job
timeline, which doubles as the resend guard.
"""
import uuid
from datetime import timedelta, time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Activity, Client, Property, Job, Message
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id, name="Sasha Cleaner"):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = name
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def world(monkeypatch):
    sent = []
    def fake_send_sms(to, body):
        sent.append({"to": to, "body": body})
        return {"sid": f"SM{len(sent)}", "status": "sent"}
    monkeypatch.setattr("integrations.twilio_client.send_sms", fake_send_sms)

    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Jordan Waters {tag}", status="active", org_id=1, phone="2075550166")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"5 Bay {tag}", address=f"5 Bay {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    today_job = Job(client_id=c.id, property_id=p.id, job_type="residential",
                    title="Today clean", scheduled_date=business_today(),
                    start_time=time(9, 0), end_time=time(11, 0),
                    cleaner_ids=["CT-tx-1"], status="scheduled", org_id=1)
    tomorrow_job = Job(client_id=c.id, property_id=p.id, job_type="residential",
                       title="Tomorrow clean",
                       scheduled_date=business_today() + timedelta(days=1),
                       start_time=time(13, 0), end_time=time(15, 0),
                       cleaner_ids=["CT-tx-1"], status="scheduled", org_id=1)
    db.add_all([today_job, tomorrow_job]); db.commit()
    db.refresh(today_job); db.refresh(tomorrow_job)
    ids = {"jobs": [today_job.id, tomorrow_job.id], "prop": p.id, "client": c.id}
    out = {"sent": sent, "today": today_job.id, "tomorrow": tomorrow_job.id}
    db.close()
    yield out
    db = SessionLocal()
    db.query(Activity).filter(Activity.job_id.in_(ids["jobs"])).delete(synchronize_session=False)
    db.query(Message).filter(Message.client_id == ids["client"]).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids["prop"]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids["client"]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_no_phone_in_payload_and_structured_send(world):
    try:
        api = _as(_Cleaner(9921, "CT-tx-1"))
        rows = api.get("/api/crew/my-day").json()["today"]
        mine = [j for j in rows if j["id"] == world["today"]][0]
        assert "client_phone" not in mine
        assert mine["can_text_client"] is True

        r = api.post(f"/api/crew/jobs/{world['today']}/notify-client",
                     json={"template": "on_the_way", "note": "It's Sasha today!"})
        assert r.status_code == 200, r.text
        assert len(world["sent"]) == 1
        body = world["sent"][0]["body"]
        assert body.startswith("Hi Jordan!")          # client first name
        assert "Sasha" in body                        # cleaner first name
        assert "on the way" in body
        assert "It's Sasha today!" in body            # personal line rides inside
        assert world["sent"][0]["to"].endswith("2075550166")

        # Once per (job, template): the timeline guard blocks a resend.
        r = api.post(f"/api/crew/jobs/{world['today']}/notify-client",
                     json={"template": "on_the_way"})
        assert r.status_code == 409
        assert len(world["sent"]) == 1
    finally:
        _clear()


def test_day_gating_and_assignment(world):
    try:
        api = _as(_Cleaner(9922, "CT-tx-1"))
        # "tomorrow" template on today's job → refused; right on tomorrow's.
        assert api.post(f"/api/crew/jobs/{world['today']}/notify-client",
                        json={"template": "tomorrow"}).status_code == 409
        r = api.post(f"/api/crew/jobs/{world['tomorrow']}/notify-client",
                     json={"template": "tomorrow"})
        assert r.status_code == 200
        assert "tomorrow at 1 PM" in world["sent"][-1]["body"]
        # "on the way" for a job that isn't today → refused.
        assert api.post(f"/api/crew/jobs/{world['tomorrow']}/notify-client",
                        json={"template": "on_the_way"}).status_code == 409
        _clear()
        # Unassigned cleaner → the job doesn't exist for them.
        intruder = _as(_Cleaner(9923, "CT-tx-9"))
        assert intruder.post(f"/api/crew/jobs/{world['today']}/notify-client",
                             json={"template": "on_the_way"}).status_code == 404
    finally:
        _clear()
