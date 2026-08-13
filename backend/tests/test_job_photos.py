"""Job photos (job_photos table): crew-uploaded before/after shots.

The contract under test, in the order it would embarrass the office if broken:

  1. Object-level authorization — a cleaner with a valid token can only touch
     photos on jobs assigned to THEIR crew ID; anyone else's job reads as 404
     (upload, list, serve, and delete alike). This is the bug class that
     survives code review most often (photos are of clients' homes).
  2. Roundtrip — a cleaner's upload is listed and served back byte-identical,
     with the content type sniffed from the bytes (never the client header).
  3. Delete rules — cleaners remove only their own uploads; office any.
  4. Caps — non-image bytes 400, >5MB 413, unknown kind clamped to untagged.
  5. Tenant scope — another org's job 404s (job_photos is in TENANT_TABLES;
     this covers the endpoint layer above the RLS backstop).
"""
import uuid
from datetime import time

from fastapi.testclient import TestClient

import pytest

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, JobPhoto
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today

# Real magic bytes with filler — the endpoint sniffs prefixes and never decodes.
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"x" * 64


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.cleaner_id = cleaner_id


class _Admin:
    def __init__(self, uid=9100):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "admin", "active", True
        self.email = f"admin-{uid}@example.com"
        self.cleaner_id = None


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(JobPhoto).filter(JobPhoto.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_job(ids, cleaner_ids, org_id=1):
    db = SessionLocal()
    c = Client(name=f"Photo {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="12 Birch Ln", address="12 Birch Ln", org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Clean",
            scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=cleaner_ids, status="scheduled", org_id=org_id)
    db.add(j); db.commit(); db.refresh(j)
    ids["clients"].append(c.id); ids["properties"].append(p.id); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _upload(api, jid, content=PNG, name="photo.png", mime="image/png", kind=None):
    data = {"kind": kind} if kind is not None else {}
    return api.post(f"/api/crew/jobs/{jid}/photos",
                    files={"file": (name, content, mime)}, data=data)


def test_upload_list_serve_roundtrip(ids):
    jid = _mk_job(ids, ["CT-301"])
    try:
        api = _as(_Cleaner(9301, "CT-301"))
        r = _upload(api, jid, kind="Before")   # case-insensitive tag
        assert r.status_code == 200, r.text
        row = r.json()
        assert row["kind"] == "before"
        assert row["content_type"] == "image/png"   # sniffed from bytes
        assert row["size_bytes"] == len(PNG)
        assert row["mine"] is True

        listed = api.get(f"/api/crew/jobs/{jid}/photos")
        assert listed.status_code == 200
        assert [p["id"] for p in listed.json()] == [row["id"]]

        served = api.get(f"/api/crew/jobs/{jid}/photos/{row['id']}")
        assert served.status_code == 200
        assert served.content == PNG
        assert served.headers["content-type"].startswith("image/png")
        assert "max-age" in served.headers.get("cache-control", "")

        # The office sees the same photo on the job (JobDetail gallery path).
        _clear()
        office = _as(_Admin())
        listed = office.get(f"/api/crew/jobs/{jid}/photos")
        assert listed.status_code == 200 and len(listed.json()) == 1
        assert listed.json()[0]["mine"] is False
    finally:
        _clear()


def test_unassigned_cleaner_is_denied_everywhere(ids):
    """THE authorization test: a valid cleaner token on someone else's job must
    read as 404 on every photo route — upload, list, and serve."""
    jid = _mk_job(ids, ["CT-401"])
    try:
        owner = _as(_Cleaner(9401, "CT-401"))
        pid = _upload(owner, jid).json()["id"]
        _clear()

        intruder = _as(_Cleaner(9402, "CT-999"))
        assert _upload(intruder, jid).status_code == 404
        assert intruder.get(f"/api/crew/jobs/{jid}/photos").status_code == 404
        assert intruder.get(f"/api/crew/jobs/{jid}/photos/{pid}").status_code == 404
        assert intruder.delete(f"/api/crew/jobs/{jid}/photos/{pid}").status_code == 404
    finally:
        _clear()


def test_delete_own_only_for_cleaners_any_for_office(ids):
    jid = _mk_job(ids, ["CT-501", "CT-502"])
    try:
        first = _as(_Cleaner(9501, "CT-501"))
        mine = _upload(first, jid).json()["id"]
        _clear()
        second = _as(_Cleaner(9502, "CT-502"))
        theirs = _upload(second, jid, content=JPEG, name="p.jpg", mime="image/jpeg").json()["id"]

        # A teammate on the same job can SEE both but delete only their own.
        assert second.delete(f"/api/crew/jobs/{jid}/photos/{mine}").status_code == 404
        assert second.delete(f"/api/crew/jobs/{jid}/photos/{theirs}").status_code == 200
        _clear()

        office = _as(_Admin())
        assert office.delete(f"/api/crew/jobs/{jid}/photos/{mine}").status_code == 200
        assert office.get(f"/api/crew/jobs/{jid}/photos").json() == []
    finally:
        _clear()


def test_rejects_non_images_and_oversize(ids):
    jid = _mk_job(ids, ["CT-601"])
    try:
        api = _as(_Cleaner(9601, "CT-601"))
        # Claims to be a PNG; bytes say otherwise. The sniff wins.
        r = _upload(api, jid, content=b"<script>alert(1)</script>", name="x.png")
        assert r.status_code == 400

        big = JPEG + b"\x00" * (5 * 1024 * 1024)
        assert _upload(api, jid, content=big, name="big.jpg", mime="image/jpeg").status_code == 413

        # Unknown tag is clamped to untagged, never rejected.
        r = _upload(api, jid, kind="sideways")
        assert r.status_code == 200 and r.json()["kind"] is None
    finally:
        _clear()


def test_other_orgs_job_is_invisible(ids):
    jid = _mk_job(ids, ["CT-701"], org_id=2)
    try:
        # Same crew ID, but the caller resolves to org 1 — tenant scope wins.
        api = _as(_Cleaner(9701, "CT-701"))
        assert _upload(api, jid).status_code == 404
        assert api.get(f"/api/crew/jobs/{jid}/photos").status_code == 404
        _clear()
        office = _as(_Admin())
        assert office.get(f"/api/crew/jobs/{jid}/photos").status_code == 404
    finally:
        _clear()
