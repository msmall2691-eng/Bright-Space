"""BB-SCHED-04: a recurring cancel clears a marketplace rate whose sub is gone.

_cancel_side_effects is the one place every recurring cancel funnels through
(series edit resync, off-phase drift cleanup, split, series cancel, skip). It
already took the job off the board (close_offer); it now also runs
release_if_displaced, so the resync paths that cancel-and-regenerate can't
leave a ghost agreed_rate behind to re-price a re-opened visit. It is a no-op
unless the agreed cleaner has actually left the row — a plain cancel that keeps
its cleaner does NOT wipe the rate.
"""
import uuid
from datetime import date, time

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, JobClaimRequest
from modules.recurring.router import _cancel_side_effects


@pytest.fixture
def ctx():
    db = SessionLocal()
    made = {"clients": []}

    def job(*, agreed_cleaner_id, agreed_rate, cleaner_ids):
        c = Client(name=f"C{uuid.uuid4().hex[:5]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        made["clients"].append(c.id)
        p = Property(client_id=c.id, name="P", address="1 St",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        j = Job(client_id=c.id, property_id=p.id, title="Visit", job_type="residential",
                scheduled_date=date(2026, 9, 1), start_time=time(10, 0), end_time=time(12, 0),
                status="cancelled", org_id=1, cleaner_ids=cleaner_ids,
                agreed_cleaner_id=agreed_cleaner_id, agreed_rate=agreed_rate)
        db.add(j); db.commit(); db.refresh(j)
        return j

    yield db, job

    db.rollback()
    cids = made["clients"] or [0]
    jids = [r[0] for r in db.query(Job.id).filter(Job.client_id.in_(cids)).all()]
    if jids:
        db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(jids)).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(cids)).delete(synchronize_session=False)
    db.commit(); db.close()


def test_displaced_rate_is_cleared_and_the_approved_request_declined(ctx):
    db, job = ctx
    # The sub who agreed the $95 rate (A) is no longer on the job — the resync
    # put someone else (B) on the regenerated visit and left this row behind.
    j = job(agreed_cleaner_id="A", agreed_rate=95.0, cleaner_ids=["B"])
    db.add(JobClaimRequest(org_id=1, job_id=j.id, cleaner_id="A", user_id=None,
                           status="approved"))
    db.commit()

    _cancel_side_effects(db, j, notify=False)
    db.commit(); db.refresh(j)

    assert j.agreed_rate is None
    assert j.agreed_cleaner_id is None
    req = db.query(JobClaimRequest).filter_by(job_id=j.id, cleaner_id="A").first()
    assert req.status == "declined"


def test_a_plain_cancel_keeps_the_rate_when_the_sub_is_still_on_it(ctx):
    db, job = ctx
    # The agreed sub (A) is still the one on the job — cancelling must not wipe
    # the rate they negotiated (release_if_displaced is a no-op here).
    j = job(agreed_cleaner_id="A", agreed_rate=95.0, cleaner_ids=["A"])

    _cancel_side_effects(db, j, notify=False)
    db.commit(); db.refresh(j)

    assert j.agreed_rate == 95.0
    assert j.agreed_cleaner_id == "A"
