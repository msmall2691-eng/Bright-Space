"""Crew morning digest (services/crew_digest.py).

R1 note: the digest is NOT a scheduler tick — it rides the existing
job_sms_reminders tick. What's under test here is the pure build step and
the gate logic: only cleaners WITH jobs get a digest (a day off stays
quiet), the body leads with count + first stop, the send pass fires once
per day (marker) and only inside the 6–9am business window.
"""
import uuid
from datetime import datetime, time

import pytest

from database.db import SessionLocal
from database.models import AppSetting, Client, Property, Job, User
from services.crew_digest import (
    MARKER_KEY, build_crew_digests, send_crew_morning_digests,
)
from utils.dates import business_today


@pytest.fixture
def ids():
    made = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield made
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(AppSetting).filter(AppSetting.key == MARKER_KEY).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_world(db, ids, tag):
    busy = User(email=f"busy-{tag}@x.com", full_name="Busy", role="cleaner",
                cleaner_id=f"CT-dg-{tag}-1", org_id=1, password_hash="x")
    idle = User(email=f"idle-{tag}@x.com", full_name="Idle", role="cleaner",
                cleaner_id=f"CT-dg-{tag}-2", org_id=1, password_hash="x")
    db.add_all([busy, idle]); db.commit()
    db.refresh(busy); db.refresh(idle)
    ids["users"] += [busy.id, idle.id]
    c = Client(name=f"Dg {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name="12 Oak St", address="12 Oak St", org_id=1)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    for start in (time(13, 0), time(9, 0)):   # out of order on purpose
        j = Job(client_id=c.id, property_id=p.id, job_type="residential",
                title=f"Dg clean {start}", scheduled_date=business_today(),
                start_time=start, end_time=time(start.hour + 2, 0),
                cleaner_ids=[busy.cleaner_id], status="scheduled", org_id=1)
        db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    return busy, idle


def test_build_digests_only_for_cleaners_with_jobs(ids):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    busy, idle = _mk_world(db, ids, tag)
    digests = build_crew_digests(db, business_today())
    db.close()
    by_user = {d["user_id"]: d for d in digests}
    assert busy.id in by_user
    assert idle.id not in by_user                   # day off stays quiet
    body = by_user[busy.id]["body"]
    assert body.startswith("2 jobs today")
    assert "first at 9 AM" in body                  # earliest job leads
    assert "12 Oak St" in body


def test_send_pass_gates_window_and_daily_marker(ids, monkeypatch):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    _mk_world(db, ids, tag)

    import services.crew_digest as cd
    sent_to = []
    monkeypatch.setattr("services.push_service.push_enabled", lambda: True)
    monkeypatch.setattr("services.push_service.notify_user",
                        lambda uid, *a, **k: (sent_to.append(uid), 1)[1])

    today = business_today()
    seven_am = datetime(today.year, today.month, today.day, 7, 5)
    # Outside the window → nothing, no marker.
    r = cd.send_crew_morning_digests(db, now=seven_am.replace(hour=11))
    assert r == {"skipped": True, "reason": "outside_window"}
    # Inside → sends and marks.
    r = cd.send_crew_morning_digests(db, now=seven_am)
    assert r["skipped"] is False and r["pushes_sent"] >= 1
    assert len(sent_to) >= 1
    # Second pass same morning → marker short-circuits, no double push.
    before = len(sent_to)
    r = cd.send_crew_morning_digests(db, now=seven_am.replace(hour=8))
    assert r == {"skipped": True, "reason": "already_sent"}
    assert len(sent_to) == before
    db.close()
