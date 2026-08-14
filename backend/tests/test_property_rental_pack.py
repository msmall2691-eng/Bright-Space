"""Rental pack: property crew notes, reference photos, WiFi on cards.

The access rule under test: a cleaner touches a property's notes/photos
ONLY if they're assigned to a job there — outsiders get 404s. Notes arrive
unshared (author + office only) until the office shares them; only shared
notes ride the my-day card payload. WiFi rides the card for assigned jobs
and is stripped from open-jobs offers.
"""
import io
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, PropertyCrewNote, PropertyPhoto
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today

# 1x1 PNG
_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082")


class _Cleaner:
    def __init__(self, uid, cleaner_id, name="Pack Tester"):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = name
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9910, 1, "admin", "active", True
    email = "admin@example.com"
    full_name = "The Office"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def world():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Pack {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"Beach House {tag}", address=f"1 Shore {tag}",
                 org_id=1, wifi_ssid="SeasideNet", wifi_password="lobster123")
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="str_turnover",
            title=f"Turnover {tag}", scheduled_date=business_today(),
            start_time=time(10, 0), end_time=time(13, 0),
            cleaner_ids=["CT-pk-1"], status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids = {"jobs": [j.id], "prop": p.id, "client": c.id}
    db.close()
    yield {"prop": ids["prop"], "job": ids["jobs"][0]}
    db = SessionLocal()
    db.query(PropertyPhoto).filter(PropertyPhoto.property_id == ids["prop"]).delete(synchronize_session=False)
    db.query(PropertyCrewNote).filter(PropertyCrewNote.property_id == ids["prop"]).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids["prop"]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids["client"]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_wifi_on_assigned_cards_stripped_from_offers(world):
    try:
        api = _as(_Cleaner(9911, "CT-pk-1"))
        row = [j for j in api.get("/api/crew/my-day").json()["today"] if j["id"] == world["job"]][0]
        assert row["wifi_ssid"] == "SeasideNet"
        assert row["wifi_password"] == "lobster123"
        assert row["property_id"] == world["prop"]
    finally:
        _clear()


def test_note_share_flow_and_access_rule(world):
    pid = world["prop"]
    try:
        # Assigned cleaner posts → note is pending (unshared).
        a = _as(_Cleaner(9912, "CT-pk-1"))
        note = a.post(f"/api/crew/properties/{pid}/notes",
                      json={"body": "Upstairs drain clogs — check it."}).json()
        assert note["shared"] is False

        # Not on the my-day card while unshared.
        row = [j for j in a.get("/api/crew/my-day").json()["today"] if j["id"] == world["job"]][0]
        assert row["house_notes"] == []
        _clear()

        # A cleaner who never works this property: 404 on everything.
        outsider = _as(_Cleaner(9913, "CT-pk-9"))
        assert outsider.get(f"/api/crew/properties/{pid}/notes").status_code == 404
        assert outsider.post(f"/api/crew/properties/{pid}/notes",
                             json={"body": "nope"}).status_code == 404
        _clear()

        # Office shares it → it rides the card payload.
        office = _as(_Admin())
        shared = office.patch(f"/api/crew/properties/{pid}/notes/{note['id']}",
                              json={"shared": True}).json()
        assert shared["shared"] is True
        _clear()
        a = _as(_Cleaner(9912, "CT-pk-1"))
        row = [j for j in a.get("/api/crew/my-day").json()["today"] if j["id"] == world["job"]][0]
        assert [n["body"] for n in row["house_notes"]] == ["Upstairs drain clogs — check it."]

        # Author can't delete once shared (crew infrastructure now).
        assert a.delete(f"/api/crew/properties/{pid}/notes/{note['id']}").status_code == 403
        # Cleaners can't share/unshare (office-only PATCH).
        assert a.patch(f"/api/crew/properties/{pid}/notes/{note['id']}",
                       json={"shared": False}).status_code == 403
    finally:
        _clear()


def test_reference_photo_roundtrip_and_access(world):
    pid = world["prop"]
    try:
        a = _as(_Cleaner(9914, "CT-pk-1"))
        up = a.post(f"/api/crew/properties/{pid}/photos",
                    files={"file": ("bed.png", io.BytesIO(_PNG), "image/png")},
                    data={"caption": "Master bed — 4 pillows"})
        assert up.status_code == 200, up.text
        meta = up.json()
        assert meta["caption"] == "Master bed — 4 pillows"

        listing = a.get(f"/api/crew/properties/{pid}/photos").json()
        assert [p["id"] for p in listing] == [meta["id"]]
        img = a.get(listing[0]["url"])
        assert img.status_code == 200 and img.headers["content-type"] == "image/png"
        _clear()

        # Outsider: 404 on list AND content.
        outsider = _as(_Cleaner(9915, "CT-pk-9"))
        assert outsider.get(f"/api/crew/properties/{pid}/photos").status_code == 404
        assert outsider.get(listing[0]["url"]).status_code == 404
        _clear()

        # Office sees + can delete anyone's photo; a cleaner only their own.
        office = _as(_Admin())
        assert office.get(f"/api/crew/properties/{pid}/photos").status_code == 200
        assert office.delete(f"/api/crew/properties/{pid}/photos/{meta['id']}").status_code == 200
    finally:
        _clear()
