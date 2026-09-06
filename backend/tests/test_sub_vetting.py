"""The vetting file: what a subcontractor has on record (migration 098).

Nothing about a sub was recorded before this beyond a login, a crew ID and a
pay rate. Every later phase depends on it — nobody works as a non-employee
until their file is complete and current.

The rule that carries the weight: `can_take_jobs` is DERIVED, never stored. A
cached boolean is wrong on exactly the day it matters — the morning a COI
expires, a stored flag still says yes, and the cost of that is an uninsured
person in a customer's house.
"""
import io
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import SubAgreement, SubDocument, User
from modules.auth.router import get_current_user, current_org_id
from services.sub_vetting import (
    CURRENT_AGREEMENT_VERSION, can_take_jobs, expiring_documents, is_expired,
    missing_requirements, vetting_status,
)
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"sub-{uid}@example.com"
        self.full_name = f"Sub {uid}"
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9970, 1, "admin", "active", True
    email = "office2@example.com"
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
def sub():
    """A real user row, because the documents hang off a FK to it."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    u = User(email=f"sub-{tag}@example.com", role="cleaner", full_name=f"Sub {tag}",
             org_id=1, active=True, status="active", cleaner_id=f"CT-{tag}")
    db.add(u); db.commit(); db.refresh(u)
    uid = u.id
    yield db, uid
    db.query(SubDocument).filter(SubDocument.user_id == uid).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id == uid).delete(synchronize_session=False)
    db.query(User).filter(User.id == uid).delete(synchronize_session=False)
    db.commit(); db.close()
    _clear()


def _doc(db, uid, kind, status="accepted", expires=None, data=b"x"):
    d = SubDocument(org_id=1, user_id=uid, kind=kind, status=status,
                    expires_at=expires, data=data, filename=f"{kind}.pdf",
                    content_type="application/pdf", size_bytes=len(data))
    db.add(d); db.commit()
    return d


def _sign(db, uid, version=CURRENT_AGREEMENT_VERSION):
    db.add(SubAgreement(org_id=1, user_id=uid, version=version,
                        accepted_at=business_today()))
    db.commit()


def _complete_file(db, uid):
    _sign(db, uid)
    _doc(db, uid, "w9")
    _doc(db, uid, "coi", expires=business_today() + timedelta(days=90))


# ── what a complete file is ─────────────────────────────────────────────────

def test_a_complete_current_file_clears_someone_to_work(sub):
    db, uid = sub
    _complete_file(db, uid)
    assert can_take_jobs(db, uid) is True
    assert missing_requirements(db, uid) == []


def test_an_empty_file_names_every_missing_piece_in_order(sub):
    db, uid = sub
    missing = missing_requirements(db, uid)
    assert missing == [
        "Sign the subcontractor agreement",
        "Upload your w-9",
        "Upload your certificate of insurance",
    ]
    assert can_take_jobs(db, uid) is False


def test_an_uploaded_but_unreviewed_document_says_so(sub):
    # The sub has nothing left to do; telling them to upload it again is a lie.
    db, uid = sub
    _sign(db, uid)
    _doc(db, uid, "w9", status="pending")
    _doc(db, uid, "coi", status="accepted", expires=business_today() + timedelta(days=30))
    assert missing_requirements(db, uid) == ["W-9 is waiting for the office to review it"]


# ── the day it matters ──────────────────────────────────────────────────────

def test_an_expired_coi_stops_work_even_while_its_status_says_accepted(sub):
    """The reason can_take_jobs is derived rather than stored.

    Nobody touches the row on the day it lapses — not the sub, not the office.
    So the stored status still reads "accepted" and only the DATE knows the
    truth. A cached boolean would have said yes.
    """
    db, uid = sub
    _sign(db, uid)
    _doc(db, uid, "w9")
    stale = _doc(db, uid, "coi", status="accepted",
                 expires=business_today() - timedelta(days=1))
    assert stale.status == "accepted"          # nothing marked it otherwise
    assert is_expired(stale) is True
    assert can_take_jobs(db, uid) is False
    assert missing_requirements(db, uid) == [
        "Your certificate of insurance expired — upload a current one"]


def test_the_file_view_reports_expired_over_the_stored_status(sub):
    db, uid = sub
    _doc(db, uid, "coi", status="accepted", expires=business_today() - timedelta(days=5))
    coi = next(d for d in vetting_status(db, uid)["documents"] if d["kind"] == "coi")
    assert coi["status"] == "expired"


def test_a_licence_expiring_does_not_stop_work(sub):
    # Not every service needs one; blocking on a document nobody asked for
    # teaches people to ignore the file.
    db, uid = sub
    _complete_file(db, uid)
    _doc(db, uid, "license", expires=business_today() - timedelta(days=10))
    assert can_take_jobs(db, uid) is True


def test_lapsing_documents_surface_for_the_office(sub):
    db, uid = sub
    _doc(db, uid, "coi", expires=business_today() - timedelta(days=2))
    rows = [r for r in expiring_documents(db, org_id=1) if r["user_id"] == uid]
    assert rows and rows[0]["expired"] is True
    assert rows[0]["days_left"] < 0

    # And a healthy one is not reported at all.
    db.query(SubDocument).filter(SubDocument.user_id == uid).delete(synchronize_session=False)
    db.commit()
    _doc(db, uid, "coi", expires=business_today() + timedelta(days=200))
    assert [r for r in expiring_documents(db, org_id=1) if r["user_id"] == uid] == []


# ── the gate ────────────────────────────────────────────────────────────────

def test_a_sub_with_an_incomplete_file_cannot_ask_for_a_job(sub):
    db, uid = sub
    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    r = api.post("/api/crew/jobs/1/claim")
    assert r.status_code == 403
    detail = r.json()["detail"]
    # The list is the point: "finish your file" without naming the piece is
    # the same as no message at all.
    assert "Sign the subcontractor agreement" in detail["missing"]
    _clear()


def test_the_gate_opens_once_the_file_is_complete(sub):
    db, uid = sub
    _complete_file(db, uid)
    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    # Past the vetting gate — the 404 is the job not existing, which is the
    # next check, and is what "no longer blocked on the file" looks like.
    r = api.post("/api/crew/jobs/999999/claim")
    assert r.status_code == 404
    _clear()


# ── the agreement ───────────────────────────────────────────────────────────

def test_accepting_the_agreement_is_append_only(sub):
    db, uid = sub
    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    from services.sub_agreement import current
    body = {"sha256": current()["sha256"]}
    api.post("/api/crew/my-file/agreement", json=body)
    api.post("/api/crew/my-file/agreement", json=body)   # a second tap is not a second row
    _clear()

    rows = db.query(SubAgreement).filter(SubAgreement.user_id == uid).all()
    assert len(rows) == 1
    assert rows[0].version == CURRENT_AGREEMENT_VERSION


def test_an_old_agreement_version_does_not_count_as_current(sub):
    # Raising the version is how everyone is asked to re-accept; a stale
    # acceptance satisfying the gate would make that meaningless.
    db, uid = sub
    _sign(db, uid, version="2020-01")
    _doc(db, uid, "w9")
    _doc(db, uid, "coi", expires=business_today() + timedelta(days=90))
    assert "Sign the subcontractor agreement" in missing_requirements(db, uid)


# ── uploads ─────────────────────────────────────────────────────────────────

def test_uploading_a_coi_requires_its_expiry_date(sub):
    db, uid = sub
    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    r = api.post("/api/crew/my-file/coi",
                 files={"file": ("coi.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")})
    assert r.status_code == 422
    assert "expiry" in r.json()["detail"]

    r2 = api.post("/api/crew/my-file/coi",
                  files={"file": ("coi.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")},
                  data={"expires_at": (business_today() + timedelta(days=365)).isoformat()})
    assert r2.status_code == 200, r2.text
    _clear()


def test_re_uploading_replaces_the_file_and_resets_the_review(sub):
    # Three COIs and no way to tell which is live is worse than one that might
    # be stale — and the office's note on the OLD file would read as a verdict
    # on the new one.
    db, uid = sub
    _doc(db, uid, "w9", status="accepted")
    db.query(SubDocument).filter(SubDocument.user_id == uid,
                                 SubDocument.kind == "w9").update({"notes": "illegible"})
    db.commit()

    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    r = api.post("/api/crew/my-file/w9",
                 files={"file": ("w9.pdf", io.BytesIO(b"%PDF-new"), "application/pdf")})
    assert r.status_code == 200, r.text
    _clear()

    db.expire_all()
    rows = db.query(SubDocument).filter(SubDocument.user_id == uid,
                                        SubDocument.kind == "w9").all()
    assert len(rows) == 1, "one row per (person, kind)"
    assert rows[0].status == "pending", "a replacement has not been reviewed"
    assert rows[0].notes is None, "the old verdict must not stick to the new file"


def test_a_non_document_upload_is_refused(sub):
    db, uid = sub
    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    r = api.post("/api/crew/my-file/w9",
                 files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")})
    assert r.status_code == 422
    assert "PDF or a photo" in r.json()["detail"]
    _clear()


# ── the constraints that are product decisions ──────────────────────────────

def test_no_column_anywhere_could_hold_an_ssn():
    """A sole-proprietor W-9 carries an SSN. The document is stored as bytes
    and never parsed; nothing gets a field to put one in. EIN is allowed
    because it identifies a business, not a person — and even that isn't a
    column yet."""
    cols = {c.name.lower() for c in SubDocument.__table__.columns}
    cols |= {c.name.lower() for c in SubAgreement.__table__.columns}
    for banned in ("ssn", "tin", "social_security", "tax_id", "taxpayer_id"):
        assert not any(banned in c for c in cols), f"{banned} must not be storable"


def test_both_tables_are_covered_by_row_level_security():
    from database.rls import TENANT_TABLES
    assert "sub_documents" in TENANT_TABLES
    assert "sub_agreements" in TENANT_TABLES


# ── The agreement is a document now, not a version string ───────────────────
# CURRENT_AGREEMENT_VERSION pointed at nothing: no text in the repo, no
# endpoint serving one, no screen rendering one. Subs tapped "sign" on a
# version number, while "a contract that defines the relationship" is one of
# the criteria Maine's employment standard counts and one of the few this
# business can satisfy outright.

def test_the_current_version_has_text_behind_it():
    """The structural guard. Bumping CURRENT_AGREEMENT_VERSION without adding
    the matching file would put everyone back to signing nothing — silently,
    because every other check here only compares version strings."""
    from services.sub_agreement import current

    a = current()
    assert a["version"] == CURRENT_AGREEMENT_VERSION
    assert len(a["sha256"]) == 64
    assert len(a["text"]) > 2000, "a real agreement, not a placeholder"
    # The things the arrangement actually rests on have to be in it.
    low = a["text"].lower()
    for phrase in ("independent contractor", "not an employee", "per job",
                   "insurance", "w-9", "1099", "maine"):
        assert phrase in low, f"the agreement never mentions {phrase!r}"


def test_a_missing_version_raises_rather_than_signing_nothing():
    from services.sub_agreement import AgreementMissing, load
    with pytest.raises(AgreementMissing):
        load("0000-00")


def test_accepting_records_which_text_was_shown(sub):
    db, uid = sub
    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    try:
        shown = api.get("/api/crew/my-file/agreement").json()
        assert shown["version"] == CURRENT_AGREEMENT_VERSION
        r = api.post("/api/crew/my-file/agreement", json={"sha256": shown["sha256"]})
        assert r.status_code == 200, r.text
    finally:
        _clear()

    row = db.query(SubAgreement).filter(SubAgreement.user_id == uid).first()
    assert row.text_sha256 == shown["sha256"], \
        "the version string was never proof; the hash of the bytes is"


def test_accepting_text_the_server_no_longer_serves_is_refused(sub):
    """A phone left open across a deploy is showing a different document from
    the one on the server. Recording that as a signature would be recording a
    signature against text nobody saw."""
    db, uid = sub
    u = db.query(User).filter(User.id == uid).first()
    api = _as(_Cleaner(uid, u.cleaner_id))
    try:
        r = api.post("/api/crew/my-file/agreement", json={"sha256": "0" * 64})
        assert r.status_code == 409
        assert "updated" in r.json()["detail"].lower()
    finally:
        _clear()
    assert db.query(SubAgreement).filter(SubAgreement.user_id == uid).count() == 0
