"""What a customer learns about the person coming to their house — task #67.

THE CONSTRAINT THIS FEATURE LIVES UNDER. A customer sees who WON their job.
They never pick. The office cannot let a customer choose a cleaner, because
choosing is assigning and a subcontractor requests or accepts
(`.claude/skills/brightbase-marketplace`, Rule 0) — so the whole value of this
surface is that it gives reassurance without giving a choice, and most of what
is pinned below is what it must never turn into.

Also pinned, because it is the other half of the same trade: a subcontractor
is a real person whose name and face are now on a page served to whoever holds
a link. What crosses that line is a first name, a last initial, and a photo
they uploaded themselves. Not a phone number, not an email, not a crew ID, and
not a stable id anyone could use to follow them from job to job.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, CrewPhoto, Job, JobHelper, Property, User
from modules.auth.router import current_org_id, get_current_user
from services import crew_intro
from utils.dates import business_today

AMY, BEN = "CT-AMY-WC", "CT-BEN-WC"
# A one-pixel JPEG: real magic bytes, so the upload endpoint's sniffer accepts
# it without a test needing an image library.
JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb0043000302020202020302"
    "0202030303030406040404040408060604060a080a0a0a0a0a0a0c0c0c0c0c0c0c"
    "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0cffc000110800"
    "01000103012200021101031101ffc4001f0000010501010101010100000000000000"
    "000102030405060708090a0bffc400b5100002010303020403050504040000017d01"
    "020300041105122131410613516107227114328191a1082342b1c11552d1f0243362"
    "728209090a161718191a25262728292a3435363738393a434445464748494a535455"
    "565758595a636465666768696a737475767778797a838485868788898a9293949596"
    "9798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4"
    "d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda000801010000"
    "3f00fb3effd9")
# A 1x1 PNG, so two faces on one job come back distinguishable by their bytes.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae"
    "426082")


class _Amy:
    id, org_id, role, status, active = 9981, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "amy-wc@example.com", "Amy Sorensen", AMY


class _Ben:
    id, org_id, role, status, active = 9982, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "ben-wc@example.com", "Ben Trask", BEN


class _Office:
    id, org_id, role, status, active = 9983, 1, "admin", "active", True
    email, full_name, cleaner_id = "office-wc@example.com", "The Office", None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _anon():
    """A TestClient with no staff identity — how a customer actually arrives."""
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    return TestClient(app)


@pytest.fixture
def made():
    db = SessionLocal()
    for u in (_Amy, _Ben, _Office):
        if not db.query(User).filter(User.id == u.id).first():
            db.add(User(id=u.id, org_id=1, email=u.email, full_name=u.full_name,
                        role=u.role, status=u.status, active=u.active,
                        cleaner_id=u.cleaner_id))
    db.commit(); db.close()

    m = {"clients": [], "properties": [], "jobs": []}
    yield m

    db = SessionLocal()
    db.query(JobHelper).filter(JobHelper.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.query(CrewPhoto).filter(CrewPhoto.user_id.in_([_Amy.id, _Ben.id])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_([_Amy.id, _Ben.id, _Office.id])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _job(m, *, cleaners=(AMY,), status="scheduled", email=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Whos Coming {tag}", status="active", org_id=1, email=email)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Harbor Rd", city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Deep clean",
            scheduled_date=business_today() + timedelta(days=2),
            start_time=dtime(9, 0), end_time=dtime(14, 0), status=status,
            cleaner_ids=list(cleaners), agreed_rate=180.0,
            public_token=f"tok-{tag}")
    db.add(j); db.commit(); db.refresh(j)
    m["jobs"].append(j.id)
    out = (j.id, j.public_token, c.id)
    db.close()
    return out


def _give_amy_a_photo():
    r = _as(_Amy()).post("/api/crew/me/photo",
                         files={"file": ("me.jpg", JPEG, "image/jpeg")})
    assert r.status_code == 200, r.text
    return r.json()["photo_url"]


# ── the thing itself ───────────────────────────────────────────────────────

def test_the_customer_is_told_who_is_coming(made):
    _, token, _ = _job(made)
    body = _anon().get(f"/api/jobs/public/{token}").json()
    assert [p["name"] for p in body["crew"]] == ["Amy S."]


def test_nobody_is_named_before_somebody_has_won_the_job(made):
    """The "after approval" half of the feature. An unclaimed job has no crew,
    and a customer must not be shown a name for a visit nobody has taken —
    that is a promise the office cannot keep."""
    _, token, _ = _job(made, cleaners=())
    assert _anon().get(f"/api/jobs/public/{token}").json()["crew"] == []


def test_a_cancelled_visit_has_nobody_coming(made):
    """A name left on a cancelled card reads as "they're still coming"."""
    _, token, _ = _job(made, status="cancelled")
    assert _anon().get(f"/api/jobs/public/{token}").json()["crew"] == []


def test_the_photo_they_uploaded_is_the_photo_the_customer_gets(made):
    _give_amy_a_photo()
    _, token, _ = _job(made)
    body = _anon().get(f"/api/jobs/public/{token}").json()
    assert body["crew"][0]["has_photo"] is True
    r = _anon().get(f"/api/jobs/public/{token}/crew/0/photo")
    assert r.status_code == 200, r.text
    assert r.content == JPEG
    assert r.headers["content-type"].startswith("image/jpeg")


def test_taking_your_photo_down_takes_it_down_for_customers_too(made):
    """Consent you cannot withdraw is not consent. One tap in the crew app has
    to reach the page a customer is looking at."""
    _give_amy_a_photo()
    _, token, _ = _job(made)
    assert _anon().get(f"/api/jobs/public/{token}/crew/0/photo").status_code == 200
    assert _as(_Amy()).delete("/api/crew/me/photo").status_code == 200
    assert _anon().get(f"/api/jobs/public/{token}/crew/0/photo").status_code == 404
    assert _anon().get(f"/api/jobs/public/{token}").json()["crew"][0]["has_photo"] is False


def test_a_helper_is_named_too(made):
    """Somebody the sub brought is a person in the customer's house, which is
    the whole reason anyone is being told anything."""
    job, token, _ = _job(made)
    _as(_Amy()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"})
    crew = _anon().get(f"/api/jobs/public/{token}").json()["crew"]
    assert [(p["name"], p["is_helper"]) for p in crew] == [("Amy S.", False), ("Sam R.", True)]


def test_the_portal_shows_it_on_upcoming_visits(made):
    """Same answer through the customer's other door, from one shared service."""
    _give_amy_a_photo()
    email = f"portal-wc-{uuid.uuid4().hex[:6]}@example.com"
    _job(made, email=email)
    api = _anon()
    tok = api.post("/api/portal/verify", json={"token": _portal_token(email)})
    assert tok.status_code == 200, tok.text
    session = tok.json()["token"]
    body = api.get("/api/portal/visits",
                   headers={"Authorization": f"Bearer {session}"}).json()
    assert [p["name"] for p in body["upcoming"][0]["crew"]] == ["Amy S."]
    assert body["upcoming"][0]["crew"][0]["has_photo"] is True


def _portal_token(email: str) -> str:
    from modules.portal.router import _make_token
    from datetime import timedelta as td
    return _make_token(email, "portal_magic", td(minutes=10))


# ── what must never cross the line ─────────────────────────────────────────

def test_the_customer_gets_a_name_and_nothing_that_reaches_the_person(made):
    """A first name and a last initial. Not a phone, not an email, not a crew
    ID, and not a stable id — a per-person handle is the first half of picking
    somebody, and the second half is the only thing that is forbidden."""
    _give_amy_a_photo()
    job, token, _ = _job(made)
    _as(_Amy()).post(f"/api/crew/jobs/{job}/helpers",
                     json={"name": "Sam Reed", "phone": "207-555-0134"})
    body = _anon().get(f"/api/jobs/public/{token}").json()
    assert set(body["crew"][0]) == {"name", "has_photo", "is_helper"}
    blob = repr(body)
    for leaked in (_Amy.email, AMY, "Sorensen", "207-555-0134", str(_Amy.id)):
        assert leaked not in blob, f"{leaked!r} reached the customer"


def test_a_photo_cannot_be_fetched_for_a_person_not_on_this_job(made):
    """The public photo URL is a POSITION in one job's crew list, not a user
    id. There is no index that walks off this job onto somebody else's face."""
    _give_amy_a_photo()
    _, token, _ = _job(made, cleaners=(BEN,))          # Ben's job, Amy's photo
    for i in (0, 1, 2, 99):
        assert _anon().get(f"/api/jobs/public/{token}/crew/{i}/photo").status_code == 404
    assert _anon().get(f"/api/jobs/public/{token}/crew/-1/photo").status_code == 404


def test_a_helper_position_does_not_shift_onto_the_subs_face(made):
    """Helpers occupy positions in the list and have no photo of their own.

    The arrangement that catches an off-by-one is a helper BETWEEN two people
    with photos: Amy, Amy's helper Sam, then Ben. If the photo lookup counted
    only the people who can have one, position 1 — Sam, who has no photo —
    would quietly serve Ben's face under Sam's name, and position 2 would 404
    on a face that is really there.
    """
    _give_amy_a_photo()
    assert _as(_Ben()).post("/api/crew/me/photo",
                            files={"file": ("b.png", PNG, "image/png")}).status_code == 200
    job, token, _ = _job(made, cleaners=(AMY, BEN))
    _as(_Amy()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"})

    crew = _anon().get(f"/api/jobs/public/{token}").json()["crew"]
    assert [(p["name"], p["is_helper"]) for p in crew] == [
        ("Amy S.", False), ("Sam R.", True), ("Ben T.", False)]

    api = _anon()
    assert api.get(f"/api/jobs/public/{token}/crew/0/photo").content == JPEG
    assert api.get(f"/api/jobs/public/{token}/crew/1/photo").status_code == 404
    assert api.get(f"/api/jobs/public/{token}/crew/2/photo").content == PNG


def test_the_office_cannot_put_a_face_on_somebody(made):
    """Consent is the upload, so the upload is self-service only. There is no
    endpoint that takes a user id and a photo."""
    r = _as(_Office()).post("/api/crew/me/photo",
                            files={"file": ("x.jpg", JPEG, "image/jpeg")})
    assert r.status_code in (403, 404), r.text
    db = SessionLocal()
    assert db.query(CrewPhoto).filter(CrewPhoto.user_id == _Amy.id).count() == 0
    db.close()


def test_the_office_can_take_one_down(made):
    """"Take that down" must not wait for the person who posted it."""
    _give_amy_a_photo()
    assert _as(_Office()).delete(f"/api/crew/photo/{_Amy.id}").status_code == 200
    db = SessionLocal()
    assert db.query(CrewPhoto).filter(CrewPhoto.user_id == _Amy.id).count() == 0
    db.close()


def test_one_cleaner_cannot_fetch_another_cleaners_photo(made):
    """The staff-side serve endpoint is own-row-only for crew. A bench where
    everyone can pull everyone's face is a directory nobody agreed to."""
    _give_amy_a_photo()
    assert _as(_Ben()).get(f"/api/crew/photo/{_Amy.id}").status_code == 404
    assert _as(_Amy()).get(f"/api/crew/photo/{_Amy.id}").status_code == 200
    assert _as(_Office()).get(f"/api/crew/photo/{_Amy.id}").status_code == 200


def test_a_photo_is_never_cached_where_a_takedown_cannot_reach_it(made):
    """The public URL is unauthenticated to whoever holds the job link. A
    shared proxy holding it would outlive somebody removing their photo."""
    _give_amy_a_photo()
    _, token, _ = _job(made)
    cc = _anon().get(f"/api/jobs/public/{token}/crew/0/photo").headers["cache-control"]
    assert "private" in cc and "public" not in cc


def test_a_legacy_job_with_no_org_still_names_its_crew(made):
    """MT-3 predates plenty of rows. An org filter on a NULL org renders as
    `IS NULL` and would match nothing, so the customer would be told nobody is
    coming while somebody is on their way. The job's own crew list is the
    scope for a caller who already holds its secret token."""
    job_id, token, _ = _job(made)
    db = SessionLocal()
    db.query(Job).filter(Job.id == job_id).update({"org_id": None})
    db.commit(); db.close()
    assert [p["name"] for p in
            _anon().get(f"/api/jobs/public/{token}").json()["crew"]] == ["Amy S."]


def test_crew_photos_is_a_tenant_table():
    """The table carries org_id, so it must be listed AND actually carry the
    policy. Listing alone does nothing — migration 109 calls `apply_org_rls`
    in the same revision that creates the table, and
    tests/test_migrations_from_scratch.py checks the policy really landed."""
    from database.rls import TENANT_TABLES
    assert "crew_photos" in TENANT_TABLES


# ── the name shaping ───────────────────────────────────────────────────────

@pytest.mark.parametrize("full_name,expected", [
    ("Amy Sorensen", "Amy S."),
    ("Amy de Vries", "Amy V."),
    ("Amy", "Amy"),
    ("  Amy   Sorensen  ", "Amy S."),
    ("", None),
    (None, None),
])
def test_display_name(full_name, expected):
    assert crew_intro.display_name(full_name) == expected


def test_somebody_with_no_name_on_file_is_left_out_entirely(made):
    """Every fallback available — an email, a crew ID — is MORE identifying
    than the thing being trimmed. So there is no fallback."""
    db = SessionLocal()
    db.query(User).filter(User.id == _Amy.id).update({"full_name": None})
    db.commit(); db.close()
    _, token, _ = _job(made)
    assert _anon().get(f"/api/jobs/public/{token}").json()["crew"] == []


# ── the reminder text ──────────────────────────────────────────────────────

def test_the_reminder_names_the_one_person_coming(made):
    from services.reminder_service import build_reminder_body
    db = SessionLocal()
    job = db.query(Job).filter(Job.id == _job(made)[0]).first()
    client = db.query(Client).filter(Client.id == job.client_id).first()
    with_name = build_reminder_body(job, client, ["Amy S."])
    without = build_reminder_body(job, client, None)
    db.close()
    assert "with Amy S." in with_name
    # One sentence, not two — the crew phrase folds into the existing sentence,
    # so naming people never tips a reminder into a second billed segment.
    assert with_name.count(". ") == without.count(". ")


def test_the_reminder_names_everyone_coming(made):
    """All crew are credited now (BB-CUST-02), not just a solo cleaner — the
    whole list folds into the one sentence; the confirm link still shows faces."""
    from services.reminder_service import build_reminder_body, _crew_names_by_job
    job_id, _, _ = _job(made, cleaners=(AMY, BEN))
    db = SessionLocal()
    job = db.query(Job).filter(Job.id == job_id).first()
    client = db.query(Client).filter(Client.id == job.client_id).first()
    names = _crew_names_by_job(db, [job]).get(job.id) or []
    body = build_reminder_body(job, client, names)
    without = build_reminder_body(job, client, None)
    db.close()
    assert len(names) == 2
    for n in names:
        assert n in body
    assert " and " in body                      # "with Amy S. and Ben T."
    # Still one sentence: the crew phrase folds in, it does not append a new
    # "Confirm..." clause (the confirm line appears exactly once, as always).
    assert body.count("Confirm or request a change") == 1
    assert without.count("Confirm or request a change") == 1
