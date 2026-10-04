"""Crew property-photo endpoint — the Street View house picture on the job card.

Same assigned-only rule as the rest of the crew job context: the photo reveals
which house this is, so an unassigned cleaner (even a lead who can see the whole
month) gets a 404. The Google call itself is mocked — we're testing the gate and
the plumbing, not Google's imagery (the service layer is covered in
test_property_media.py and is fail-soft by design).
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today
import services.property_media as pm
import services.sub_vetting as sv


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = "Pat Tester"
        self.cleaner_id = cleaner_id
        self.can_view_full_schedule = True   # even a lead gets 404 on others' photos


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def job():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Pho {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"9 Oak {tag}", address=f"9 Oak {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title=f"Pho clean {tag}", scheduled_date=business_today(),
            start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=["CT-pho-1"], status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids = (j.id, p.id, c.id)
    db.close()
    yield ids[0]
    db = SessionLocal()
    db.query(Job).filter(Job.id == ids[0]).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids[1]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids[2]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_assigned_cleaner_gets_the_photo(job, monkeypatch):
    monkeypatch.setattr(pm, "street_view_enabled", lambda db: True)
    monkeypatch.setattr(pm, "street_view_bytes", lambda addr, key, size="640x360": b"JPEGBYTES")
    try:
        r = _as(_Cleaner(9985, "CT-pho-1")).get(f"/api/crew/jobs/{job}/property-photo")
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/jpeg"
        assert r.content == b"JPEGBYTES"
    finally:
        _clear()


def test_unassigned_cleaner_404s_without_calling_google(job, monkeypatch):
    # The assignment gate runs BEFORE the photo service, so an unassigned
    # cleaner never even triggers a (paid) Street View lookup.
    called = {"n": 0}

    def _boom(*a, **k):
        called["n"] += 1
        return b"x"

    monkeypatch.setattr(pm, "street_view_enabled", lambda db: True)
    monkeypatch.setattr(pm, "street_view_bytes", _boom)
    try:
        r = _as(_Cleaner(9986, "CT-pho-2")).get(f"/api/crew/jobs/{job}/property-photo")
        assert r.status_code == 404
        assert called["n"] == 0
    finally:
        _clear()


def test_photos_off_404s(job, monkeypatch):
    monkeypatch.setattr(pm, "street_view_enabled", lambda db: False)
    try:
        r = _as(_Cleaner(9987, "CT-pho-1")).get(f"/api/crew/jobs/{job}/property-photo")
        assert r.status_code == 404
    finally:
        _clear()


def test_enabled_but_no_imagery_404s(job, monkeypatch):
    monkeypatch.setattr(pm, "street_view_enabled", lambda db: True)
    monkeypatch.setattr(pm, "street_view_bytes", lambda addr, key, size="640x360": None)
    try:
        r = _as(_Cleaner(9988, "CT-pho-1")).get(f"/api/crew/jobs/{job}/property-photo")
        assert r.status_code == 404
    finally:
        _clear()


# ── Open offers (owner's Oct 2026 decision) ─────────────────────────────────
# A cleared sub looking at a job that's up for grabs now gets the house photo so
# they can judge the property before deciding — gated to the same visibility as
# the open board (cleared + open_for_claims + scheduled + audience). The street
# address and the customer's name still never ride the offer.

@pytest.fixture
def open_job():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Op {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"7 Elm {tag}", address=f"7 Elm {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="str_turnover",
            title=f"Op turn {tag}", scheduled_date=business_today(),
            start_time=time(10, 0), end_time=time(15, 0),
            cleaner_ids=[], status="scheduled", open_for_claims=True, org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids = (j.id, p.id, c.id)
    db.close()
    yield ids[0]
    db = SessionLocal()
    db.query(Job).filter(Job.id == ids[0]).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids[1]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids[2]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_cleared_sub_sees_open_offer_photo(open_job, monkeypatch):
    monkeypatch.setattr(pm, "street_view_enabled", lambda db: True)
    monkeypatch.setattr(pm, "street_view_bytes", lambda addr, key, size="640x360": b"JPEGBYTES")
    monkeypatch.setattr(sv, "blocking_requirements", lambda db, user: [])
    try:
        r = _as(_Cleaner(9990, "CT-pho-open")).get(f"/api/crew/jobs/{open_job}/property-photo")
        assert r.status_code == 200
        assert r.content == b"JPEGBYTES"
    finally:
        _clear()


def test_not_cleared_sub_404s_on_open_offer(open_job, monkeypatch):
    # Not cleared → can't see the board, so can't see the photo. The gate runs
    # before the (paid) Street View lookup.
    called = {"n": 0}

    def _boom(*a, **k):
        called["n"] += 1
        return b"x"

    monkeypatch.setattr(pm, "street_view_enabled", lambda db: True)
    monkeypatch.setattr(pm, "street_view_bytes", _boom)
    monkeypatch.setattr(sv, "blocking_requirements", lambda db, user: ["Sign the agreement"])
    try:
        r = _as(_Cleaner(9991, "CT-pho-open2")).get(f"/api/crew/jobs/{open_job}/property-photo")
        assert r.status_code == 404
        assert called["n"] == 0
    finally:
        _clear()


def test_targeted_offer_photo_hidden_from_sub_not_in_audience(open_job, monkeypatch):
    # A targeted offer only reveals its house to the cleaners it was offered to.
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == open_job).first()
    j.offer_audience = ["CT-someone-else"]
    db.commit(); db.close()
    monkeypatch.setattr(pm, "street_view_enabled", lambda db: True)
    monkeypatch.setattr(pm, "street_view_bytes", lambda addr, key, size="640x360": b"JPEGBYTES")
    monkeypatch.setattr(sv, "blocking_requirements", lambda db, user: [])
    try:
        r = _as(_Cleaner(9992, "CT-pho-open3")).get(f"/api/crew/jobs/{open_job}/property-photo")
        assert r.status_code == 404
    finally:
        _clear()


# ── Street View uses the FULL address, not the bare street line ──────────────
# A bare "74 Central Ave" geocodes to whatever town Google guesses — a sub was
# shown a desert Street View for an Old Orchard Beach turnover. The lookup now
# composes the property's town/state/zip onto the street line.

@pytest.fixture
def job_with_town():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Town {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"74 Central {tag}", address="74 Central Ave",
                 city="Old Orchard Beach", state="ME", zip_code="04064", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="str_turnover",
            title=f"Turnover {tag}", scheduled_date=business_today(),
            start_time=time(10, 0), end_time=time(15, 0),
            cleaner_ids=["CT-town-1"], status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids = (j.id, p.id, c.id)
    db.close()
    yield ids[0]
    db = SessionLocal()
    db.query(Job).filter(Job.id == ids[0]).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids[1]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids[2]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_street_view_lookup_uses_the_full_address(job_with_town, monkeypatch):
    seen = {}

    def _capture(addr, key, size="640x360"):
        seen["addr"] = addr
        return b"JPEGBYTES"

    monkeypatch.setattr(pm, "street_view_enabled", lambda db: True)
    monkeypatch.setattr(pm, "street_view_bytes", _capture)
    try:
        r = _as(_Cleaner(9993, "CT-town-1")).get(f"/api/crew/jobs/{job_with_town}/property-photo")
        assert r.status_code == 200
        # Town + state + zip composed onto the street line — not "74 Central Ave" alone.
        assert seen["addr"] == "74 Central Ave, Old Orchard Beach, ME, 04064"
    finally:
        _clear()
