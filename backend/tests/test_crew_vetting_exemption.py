"""Don't lock the existing crew out of their own app (migration 103).

The vetting gate was designed for a bench being RECRUITED: nobody starts
without a W-9, a certificate of insurance and a signed agreement. Switched on
over a live business it did something else — every cleaner already on the books
lost the ability to claim an open job overnight, for paperwork nobody had asked
them for. The owner found out by asking what had changed.

So enforcement has a start date. What's pinned here:

  * a crew account that predates the cutoff can still claim work;
  * one created after it cannot — this is a grandfather clause, not an off
    switch;
  * an exempt person STILL READS AS INCOMPLETE everywhere the office looks.
    Hiding the gap would be the version of this that ends with an uninsured
    person in a customer's house;
  * clearing the setting applies the gate to everybody, which is what to do
    once the documents are in;
  * and the off-by-one the migration exists to avoid: `created < cutoff`, so a
    cutoff of TODAY would still gate somebody added this morning.

Plus the roster the office verifies from — one request, everyone, what each
person owes and what's sitting waiting to be accepted.
"""
import uuid
from datetime import datetime, time, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Job, Property, SubAgreement, SubDocument, User,
)
from modules.auth.router import get_current_user, current_org_id
from modules.settings.router import set_setting
from services import sub_vetting
from utils.dates import business_today, business_tz


class _Admin:
    id, org_id, role, status, active = 9401, 1, "admin", "active", True
    email = "vet-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


class _CleanerUser:
    """Stands in for the authenticated crew member. Carries created_at,
    because that is what the exemption reads."""
    def __init__(self, row):
        self.id, self.org_id, self.role = row.id, 1, "cleaner"
        self.status, self.active = "active", True
        self.email, self.full_name = row.email, row.full_name
        self.cleaner_id = row.cleaner_id
        self.created_at = row.created_at


def _api(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def made():
    m = {"users": [], "clients": [], "properties": [], "jobs": []}
    yield m
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    set_setting(db, sub_vetting.ENFORCE_FROM_KEY, "")
    db.commit(); db.close()


def _cutoff(value):
    db = SessionLocal()
    set_setting(db, sub_vetting.ENFORCE_FROM_KEY, value or "")
    db.commit(); db.close()


def _mk_crew(m, *, created_days_ago=30, name="A Cleaner", created_at=None):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    u = User(email=f"crew-{tag}@example.com", role="cleaner", full_name=f"{name} {tag}",
             org_id=1, active=True, status="active", cleaner_id=f"CT-{tag[:5]}",
             created_at=created_at or (datetime.utcnow()
                                       - timedelta(days=created_days_ago)))
    db.add(u); db.commit(); db.refresh(u)
    m["users"].append(u.id)
    out = _CleanerUser(u)
    db.close()
    return out


def _mk_open_job(m, when=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Vet {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"4 Vet Rd {tag}", address=f"4 Vet Rd {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=f"Clean {tag}",
            scheduled_date=when or business_today(), start_time=time(9, 0),
            end_time=time(11, 0), cleaner_ids=[], status="scheduled", org_id=1,
            open_for_claims=True, posted_rate=80.0)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _claim(user, jid):
    api = _api(user)
    try:
        return api.post(f"/api/crew/jobs/{jid}/claim", json={})
    finally:
        _clear()


# ── The exemption ───────────────────────────────────────────────────────────

def test_without_a_cutoff_everyone_is_gated(made):
    """The original behaviour, and what the owner ran into."""
    _cutoff(None)
    who = _mk_crew(made, created_days_ago=200)
    r = _claim(who, _mk_open_job(made))
    assert r.status_code == 403
    assert "Finish your file" in r.json()["detail"]["message"]


def test_crew_who_predate_the_cutoff_can_still_work(made):
    _cutoff((business_today() + timedelta(days=1)).isoformat())
    who = _mk_crew(made, created_days_ago=200)
    r = _claim(who, _mk_open_job(made))
    assert r.status_code == 200, r.text


def test_somebody_added_this_morning_is_still_existing_crew(made):
    """The off-by-one the migration exists to avoid.

    The comparison is `created < cutoff`. A cutoff of TODAY would gate a crew
    member created at 9am today, who is existing crew by any sensible reading.
    Migration 103 therefore sets tomorrow.
    """
    _cutoff((business_today() + timedelta(days=1)).isoformat())
    this_morning = _mk_crew(made, created_days_ago=0)
    assert _claim(this_morning, _mk_open_job(made)).status_code == 200

    # And with the naive version, they'd have been locked out.
    _cutoff(business_today().isoformat())
    assert _claim(this_morning, _mk_open_job(made)).status_code == 403


def test_an_account_opened_in_the_evening_is_not_stamped_with_tomorrow(made):
    """The same off-by-one, arriving through the timezone instead.

    created_at is UTC (models._utcnow); the cutoff is a date in the business
    timezone. From 8pm in Maine it is already tomorrow in UTC, so reading the
    stored date verbatim ages an account opened this evening by a day — and
    gates the very crew member the cutoff was set a day late to protect.

    Found by CI at 00:26 UTC, which is 8:26pm here, when
    test_somebody_added_this_morning_is_still_existing_crew started failing on
    a diff that had nothing to do with vetting. It is not a test-only problem:
    anyone added after supper on the day before the cutoff would have been
    locked out of claiming work in production.
    """
    # 9pm in Maine, the evening BEFORE the cutoff.
    evening_local = datetime(2026, 3, 10, 21, 0, tzinfo=business_tz())
    evening_utc = evening_local.astimezone(timezone.utc)
    assert evening_utc.date() > evening_local.date(), \
        "fixture must straddle midnight UTC or it proves nothing"

    _cutoff((evening_local.date() + timedelta(days=1)).isoformat())
    # Stored naive, as a UTC column holds it — that is the shape is_exempt reads.
    who = _mk_crew(made, created_at=evening_utc.replace(tzinfo=None))
    assert _claim(who, _mk_open_job(made)).status_code == 200, \
        "existing crew, added the evening before the gate started"


def test_somebody_onboarded_after_the_cutoff_still_needs_a_file(made):
    """A grandfather clause, not an off switch."""
    _cutoff((business_today() - timedelta(days=7)).isoformat())
    newcomer = _mk_crew(made, created_days_ago=1)
    r = _claim(newcomer, _mk_open_job(made))
    assert r.status_code == 403
    assert any("insurance" in x.lower() for x in r.json()["detail"]["missing"])


def test_clearing_the_cutoff_applies_the_gate_to_everybody(made):
    """What to do once the documents are actually in."""
    old_hand = _mk_crew(made, created_days_ago=300)
    _cutoff((business_today() + timedelta(days=1)).isoformat())
    assert _claim(old_hand, _mk_open_job(made)).status_code == 200
    _cutoff(None)
    assert _claim(old_hand, _mk_open_job(made)).status_code == 403


def test_an_exempt_person_still_reads_as_incomplete_to_the_office(made):
    """The exemption is about not blocking them today, not about pretending
    the documents exist. Hiding the gap is how an uninsured person ends up in
    a customer's house."""
    _cutoff((business_today() + timedelta(days=1)).isoformat())
    who = _mk_crew(made, created_days_ago=200)

    db = SessionLocal()
    status = sub_vetting.vetting_status(db, who.id)
    assert status["can_take_jobs"] is False, "the FILE is still incomplete"
    assert status["missing"], "and it still says what's missing"

    row = next(r for r in sub_vetting.roster(db, 1)["crew"] if r["user_id"] == who.id)
    db.close()
    assert row["complete"] is False
    assert row["exempt"] is True
    assert row["can_work"] is True, "not blocked today, but still owes documents"
    assert row["missing"]


def test_a_missing_created_at_counts_as_existing_crew(made):
    """A row predating the column certainly predates the gate. Nobody gets
    locked out over a missing timestamp."""
    _cutoff((business_today() + timedelta(days=1)).isoformat())
    who = _mk_crew(made, created_days_ago=10)
    db = SessionLocal()
    db.query(User).filter(User.id == who.id).update({"created_at": None})
    db.commit(); db.close()
    who.created_at = None
    assert _claim(who, _mk_open_job(made)).status_code == 200


# ── The roster the office verifies from ─────────────────────────────────────

def test_the_roster_says_who_owes_what_in_one_request(made):
    _cutoff(None)
    complete = _mk_crew(made, name="Done")
    waiting = _mk_crew(made, name="Waiting")
    nothing = _mk_crew(made, name="Nothing")

    db = SessionLocal()
    # A complete file.
    db.add(SubAgreement(org_id=1, user_id=complete.id,
                        version=sub_vetting.CURRENT_AGREEMENT_VERSION,
                        accepted_at=business_today()))
    db.add(SubDocument(org_id=1, user_id=complete.id, kind="w9",
                       status="accepted", data=b"x"))
    db.add(SubDocument(org_id=1, user_id=complete.id, kind="coi", status="accepted",
                       data=b"x", expires_at=business_today() + timedelta(days=200)))
    # Uploaded and sitting there for the office.
    db.add(SubDocument(org_id=1, user_id=waiting.id, kind="w9",
                       status="pending", data=b"x", uploaded_at=datetime.utcnow()))
    db.commit(); db.close()

    api = _api(_Admin())
    try:
        body = api.get("/api/crew/files").json()
    finally:
        _clear()

    by_id = {r["user_id"]: r for r in body["crew"]}
    assert by_id[complete.id]["complete"] is True
    assert by_id[complete.id]["missing"] == []
    assert by_id[waiting.id]["awaiting_review"] == ["w9"]
    assert any("waiting for you to review" in x
               for x in by_id[waiting.id]["missing"])
    assert by_id[nothing.id]["missing"], "no file at all is the loudest case"
    # The counts are what tell the office whether to open it at all.
    assert body["awaiting_review"] >= 1
    assert body["incomplete"] >= 2


def test_the_roster_is_office_only(made):
    who = _mk_crew(made)
    api = _api(who)
    try:
        assert api.get("/api/crew/files").status_code == 403
    finally:
        _clear()


def test_the_roster_does_not_reach_across_orgs(made):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    theirs = User(email=f"other-{tag}@example.com", role="cleaner",
                  full_name="Their Cleaner", org_id=2, active=True,
                  status="active", cleaner_id=f"CT-O{tag[:4]}")
    db.add(theirs); db.commit(); db.refresh(theirs)
    made["users"].append(theirs.id)
    other_id = theirs.id
    db.close()

    api = _api(_Admin())          # org 1
    try:
        ids = [r["user_id"] for r in api.get("/api/crew/files").json()["crew"]]
    finally:
        _clear()
    assert other_id not in ids


def test_the_upload_notification_points_at_a_real_page():
    """It said /staff, which was never a route — tapping it fell through to
    the dashboard catch-all and told the office nothing."""
    import re

    from pathlib import Path
    src = Path("modules/crew/router.py").read_text()
    upload = src[src.index('@router.post("/my-file/{kind}")'):]
    upload = upload[:upload.index("@router.get")]
    urls = re.findall(r'url="([^"]+)"', upload)
    assert urls, "the upload should still notify the office"
    assert "/staff" not in urls
    assert "/crew" in urls
