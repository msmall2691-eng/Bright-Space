"""Can this subcontractor work yet, and what's missing if not.

Migration 098 gives a sub a file: a W-9, a certificate of insurance, a signed
agreement, optionally a licence and an ID. This module is the single answer to
"is that file good enough", called from every gate — the crew claim endpoint
now, route-offer acceptance when routes land.

`can_take_jobs` is DERIVED, never stored. A cached boolean is wrong on exactly
the day it matters: the morning a COI expires, the flag would still say yes.
The cost of recomputing is two indexed queries; the cost of a stale yes is an
uninsured person in a customer's house.

WHAT IT REQUIRES, and why each one:
  - the current agreement accepted — a written contract defining the
    relationship is a named worker-classification criterion;
  - a W-9 accepted — you cannot file a 1099 without one, and the threshold is
    reached mid-year, not in January;
  - a COI accepted AND unexpired — an insurance certificate that lapsed in
    March is worse than none at all, because the office believes it has one.

A licence and a photo ID are recorded when they exist but are not gates: not
every service needs a licence, and blocking work on an ID nobody asked for
just teaches people to ignore the file.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from database.models import SubAgreement, SubDocument
from utils.dates import business_today, coerce_date

logger = logging.getLogger(__name__)

# The kinds a file can hold. Anything else is refused at the API rather than
# quietly stored under a name no screen will ever render.
DOCUMENT_KINDS = ("w9", "coi", "license", "agreement", "id")

# The kinds that gate work, in the order a person should be asked for them.
REQUIRED_KINDS = ("w9", "coi")

# Only kinds where an expiry is meaningful. A W-9 doesn't expire; asking for a
# date on one produces a date somebody invented.
EXPIRING_KINDS = ("coi", "license")

# Bump when the agreement text changes. Acceptance is per-version, so raising
# this asks everyone to re-accept — which is the point of versioning it.
CURRENT_AGREEMENT_VERSION = "2026-09"

DOCUMENT_LABELS = {
    "w9": "W-9",
    "coi": "Certificate of insurance",
    "license": "Licence",
    "agreement": "Signed agreement",
    "id": "Photo ID",
}

_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024   # a phone photo of a form, with headroom
# Deliberately narrow: a document is a PDF or a picture of one.
ALLOWED_CONTENT_TYPES = (
    "application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp",
)


def _docs_by_kind(db: Session, user_id: int) -> dict:
    rows = db.query(SubDocument).filter(SubDocument.user_id == user_id).all()
    return {d.kind: d for d in rows}


def is_expired(doc, today=None) -> bool:
    """Whether a document's own expiry has passed.

    Read from `expires_at` rather than trusting `status`: status is set by
    whoever last touched the row, and nobody touches a row on the day it
    lapses. That gap is the entire failure mode this guards.
    """
    exp = coerce_date(getattr(doc, "expires_at", None))
    return bool(exp and exp < (today or business_today()))


def has_current_agreement(db: Session, user_id: int) -> bool:
    return db.query(SubAgreement).filter(
        SubAgreement.user_id == user_id,
        SubAgreement.version == CURRENT_AGREEMENT_VERSION,
    ).first() is not None


def missing_requirements(db: Session, user_id: int) -> list:
    """What still stands between this person and taking work.

    Returns plain sentences, in the order to do them. They reach a phone
    screen unchanged — "finish your file" without saying which part is the
    same as no message at all.
    """
    today = business_today()
    docs = _docs_by_kind(db, user_id)
    missing = []

    if not has_current_agreement(db, user_id):
        missing.append("Sign the subcontractor agreement")

    for kind in REQUIRED_KINDS:
        label = DOCUMENT_LABELS[kind]
        doc = docs.get(kind)
        if doc is None or doc.status == "missing" or not doc.data:
            missing.append(f"Upload your {label.lower()}")
        elif is_expired(doc, today):
            missing.append(f"Your {label.lower()} expired — upload a current one")
        elif doc.status != "accepted":
            # Uploaded and waiting on the office. Named separately because the
            # sub has nothing left to do about it, and telling them to upload
            # it again would be a lie.
            missing.append(f"{label} is waiting for the office to review it")
    return missing


def can_take_jobs(db: Session, user_id: int) -> bool:
    """True when this sub's file is complete and current."""
    if not user_id:
        return False
    return not missing_requirements(db, user_id)


def vetting_status(db: Session, user_id: int) -> dict:
    """The whole file, for the crew's "My file" screen and the office's review.

    One shape for both so the two screens can't drift into disagreeing about
    whether somebody is cleared.
    """
    today = business_today()
    docs = _docs_by_kind(db, user_id)
    out = []
    for kind in DOCUMENT_KINDS:
        if kind == "agreement":
            continue           # tracked by sub_agreements, not as a file
        doc = docs.get(kind)
        expired = bool(doc and is_expired(doc, today))
        out.append({
            "kind": kind,
            "label": DOCUMENT_LABELS[kind],
            "required": kind in REQUIRED_KINDS,
            "expires": kind in EXPIRING_KINDS,
            # Expiry beats the stored status, for the reason in is_expired().
            "status": "expired" if expired else (doc.status if doc else "missing"),
            "expires_at": doc.expires_at.isoformat() if (doc and doc.expires_at) else None,
            "filename": doc.filename if doc else None,
            "uploaded_at": doc.uploaded_at.isoformat() if (doc and doc.uploaded_at) else None,
            "reviewed_at": doc.reviewed_at.isoformat() if (doc and doc.reviewed_at) else None,
            "notes": doc.notes if doc else None,
        })
    missing = missing_requirements(db, user_id)
    return {
        "user_id": user_id,
        "can_take_jobs": not missing,
        "missing": missing,
        "agreement_version": CURRENT_AGREEMENT_VERSION,
        "agreement_accepted": has_current_agreement(db, user_id),
        "documents": out,
    }


def expiring_documents(db: Session, org_id: int, within_days: int = 30) -> list:
    """Documents that have lapsed or are about to, for the office's findings.

    An expired COI is worse than a missing one: nobody goes looking for it,
    because the office believes it has one. So this is pushed into the place
    findings already appear rather than waiting to be asked for.
    """
    from sqlalchemy import or_

    today = business_today()
    rows = (db.query(SubDocument)
            .filter(SubDocument.kind.in_(EXPIRING_KINDS),
                    SubDocument.expires_at.isnot(None),
                    or_(SubDocument.org_id == org_id, SubDocument.org_id.is_(None)))
            .all())
    out = []
    for d in rows:
        exp = coerce_date(d.expires_at)
        if exp is None:
            continue
        days = (exp - today).days
        if days <= within_days:
            out.append({
                "user_id": d.user_id,
                "kind": d.kind,
                "label": DOCUMENT_LABELS.get(d.kind, d.kind),
                "expires_at": exp.isoformat(),
                "days_left": days,
                "expired": days < 0,
            })
    out.sort(key=lambda r: r["days_left"])
    return out
