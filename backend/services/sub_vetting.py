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


# Crew who already worked here when the gate went in are exempt from it.
#
# The gate was designed for a bench being RECRUITED: nobody starts without a
# file. Switched on over a live business it did something else — it stopped the
# existing crew claiming work overnight, for paperwork nobody had been asked
# for yet. That is the office creating an outage for itself.
#
# So enforcement has a start date. A crew account created before it keeps
# working; anyone onboarded after it goes through the gate as designed. Stored
# rather than hard-coded so the office can move it: clear the setting once
# everyone's documents are in, and the gate applies to everybody.
#
# An exempt person is still shown as INCOMPLETE everywhere the office looks.
# The exemption is about not blocking them today, not about pretending the
# documents exist — hiding the gap would be the version of this that ends with
# an uninsured person in a customer's house.
ENFORCE_FROM_KEY = "crew_vetting_enforce_from"


def enforce_from(db: Session):
    """The date the gate starts applying to a crew account, or None for all."""
    from modules.settings.router import get_setting

    return coerce_date(get_setting(db, ENFORCE_FROM_KEY))


def is_exempt(db: Session, user) -> bool:
    """True when this person predates the gate and shouldn't be blocked by it.

    Reads the USER's creation date, not today's: the question is "was this
    person already working here", and that answer doesn't change over time.
    """
    cutoff = enforce_from(db)
    if cutoff is None:
        return False
    created = coerce_date(getattr(user, "created_at", None))
    if created is None:
        # A crew row with no created_at predates the column, which means it
        # certainly predates the gate. Treat as existing crew rather than
        # blocking somebody over a missing timestamp.
        return True
    return created < cutoff


def blocking_requirements(db: Session, user) -> list:
    """What stands between this person and taking work, AFTER the exemption.

    This is what the gates call. `missing_requirements` stays the honest
    answer about the file itself and is what every screen shows, so an exempt
    person still reads as incomplete to the office.
    """
    if is_exempt(db, user):
        return []
    return missing_requirements(db, user.id)


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
        # The file's own answer, unchanged by any exemption — see is_exempt.
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


def roster(db: Session, org_id: int) -> dict:
    """Every crew member and where their file stands, in one pass.

    The office's actual question is not "is this one person cleared" — it's
    "who still owes me something". Before this you could only ask it one person
    at a time, by opening a disclosure on each row of the staff list, which is
    how a document gets uploaded on Tuesday and noticed in March.

    THREE QUERIES, not three per person: users, then all their documents, then
    all their agreements, joined in memory. A roster that cost a query each
    would be the thing that made nobody open it.
    """
    from sqlalchemy import or_

    from database.models import User

    today = business_today()
    cutoff = enforce_from(db)

    people = (db.query(User)
              .filter(User.role == "cleaner",
                      or_(User.org_id == org_id, User.org_id.is_(None)))
              .order_by(User.full_name, User.id)
              .all())
    ids = [u.id for u in people] or [0]

    docs: dict = {}
    for d in db.query(SubDocument).filter(SubDocument.user_id.in_(ids)).all():
        docs.setdefault(d.user_id, {})[d.kind] = d
    signed = {a.user_id for a in db.query(SubAgreement).filter(
        SubAgreement.user_id.in_(ids),
        SubAgreement.version == CURRENT_AGREEMENT_VERSION).all()}

    rows, waiting = [], 0
    for u in people:
        mine = docs.get(u.id, {})
        missing = []
        if u.id not in signed:
            missing.append("Sign the subcontractor agreement")
        for kind in REQUIRED_KINDS:
            label = DOCUMENT_LABELS[kind]
            doc = mine.get(kind)
            if doc is None or doc.status == "missing" or not doc.data:
                missing.append(f"Upload their {label.lower()}")
            elif is_expired(doc, today):
                missing.append(f"Their {label.lower()} has expired")
            elif doc.status != "accepted":
                missing.append(f"{label} is waiting for you to review it")

        # The one number that decides whether this row needs the office to DO
        # something, as opposed to needing the crew member to.
        to_review = [k for k, d in mine.items()
                     if d.status == "pending" and d.data]
        waiting += len(to_review)

        exempt = bool(cutoff and (coerce_date(getattr(u, "created_at", None)) is None
                                  or coerce_date(u.created_at) < cutoff))
        rows.append({
            "user_id": u.id,
            "name": u.full_name or u.email,
            "email": u.email,
            "cleaner_id": u.cleaner_id,
            "status": u.status,
            # Complete file, regardless of any exemption.
            "complete": not missing,
            "missing": missing,
            # Grandfathered in: gaps, but not blocked from working today.
            "exempt": exempt,
            "can_work": (not missing) or exempt,
            "awaiting_review": to_review,
            "documents": [{
                "kind": k,
                "label": DOCUMENT_LABELS.get(k, k),
                "status": "expired" if is_expired(d, today) else d.status,
                "expires_at": d.expires_at.isoformat() if d.expires_at else None,
                "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
                "filename": d.filename,
            } for k, d in sorted(mine.items())],
            "agreement_signed": u.id in signed,
        })

    return {
        "crew": rows,
        # What the office is looking for: documents sitting unreviewed, and
        # people whose file still has a hole in it.
        "awaiting_review": waiting,
        "incomplete": sum(1 for r in rows if not r["complete"]),
        "blocked": sum(1 for r in rows if not r["can_work"]),
        "enforce_from": cutoff.isoformat() if cutoff else None,
    }
