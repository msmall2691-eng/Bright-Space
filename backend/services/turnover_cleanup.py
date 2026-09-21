"""Purge cancelled STR-turnover *ghosts* — the piles of cancelled duplicate
turnovers a flapping iCal feed (plus, before the Rule-0 fix in ical_sync, a
manually-moved turnover getting dragged back to the booking's checkout date)
left behind on a single date.

This is a HUMAN-CONFIRMED cleanup, never automatic (scheduling-invariants R7):
the Schedule → Tools "Remove cancelled turnover clutter" action previews the
count first, and the office approves before anything is deleted. It only ever
touches rows that are BOTH `status='cancelled'` AND `job_type='str_turnover'`,
so no live work — and no non-turnover job — can be caught by it.

Two safety rails beyond that:

* **Invoices are always preserved.** A cancelled turnover that somehow carries
  an invoice is left alone (its id is reported as skipped), matching the
  standing "invoices are never destroyed" rule.
* **Per-row savepoints.** Each delete runs in a nested transaction; a row that
  can't be deleted (an unexpected FK child) is rolled back and skipped, not
  allowed to abort the whole sweep.

Why this needs bespoke unlinking: `jobs.id` is referenced by several child
tables with no `ON DELETE` behaviour (`ical_events`, `activities`, `messages`,
`invoices`). CASCADE / SET NULL children are handled by the database; these
four are not, so we null the link ourselves first (and skip on an invoice).
We deliberately do NOT set `ical_events.dismissed_at` here — dismissal is the
"office deleted this booking's turnover, don't regenerate" signal, and these
ghosts are duplicates of a booking whose ONE live turnover should keep
regenerating normally.
"""

from typing import Optional

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database.models import Job, ICalEvent, Activity, Message, Invoice, Property


def _base_query(db: Session, org_id: Optional[int], property_id: Optional[int]):
    """Cancelled turnovers for this org that carry no invoice — the purgeable
    set. Org scope is NULL-tolerant to match every other tenant query here."""
    invoiced = db.query(Invoice.job_id).filter(Invoice.job_id.isnot(None))
    q = db.query(Job).filter(
        Job.job_type == "str_turnover",
        Job.status == "cancelled",
        Job.id.notin_(invoiced),
    )
    if org_id is not None:
        q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))
    if property_id is not None:
        q = q.filter(Job.property_id == property_id)
    return q


def preview_cancelled_turnovers(db: Session, org_id: Optional[int],
                                property_id: Optional[int] = None) -> dict:
    """Dry run: how many cancelled turnover ghosts would be removed, broken down
    by property, with a sample of ids. Reads only — changes nothing."""
    jobs = _base_query(db, org_id, property_id).all()
    by_prop: dict = {}
    for j in jobs:
        by_prop.setdefault(j.property_id, 0)
        by_prop[j.property_id] += 1
    names = {}
    if by_prop:
        for p in db.query(Property).filter(Property.id.in_(list(by_prop.keys()))).all():
            names[p.id] = p.name
    breakdown = sorted(
        ({"property_id": pid, "property": names.get(pid, "—"), "count": n}
         for pid, n in by_prop.items()),
        key=lambda r: r["count"], reverse=True,
    )
    return {
        "count": len(jobs),
        "sample_ids": [j.id for j in jobs[:25]],
        "by_property": breakdown,
    }


def purge_cancelled_turnovers(db: Session, org_id: Optional[int],
                              property_id: Optional[int] = None) -> dict:
    """Hard-delete the cancelled turnover ghosts. Human-confirmed only.

    Returns {deleted, skipped, deleted_ids}. Commits once at the end."""
    jobs = _base_query(db, org_id, property_id).all()
    deleted_ids: list = []
    skipped: list = []
    for j in jobs:
        sp = db.begin_nested()
        try:
            # Null the un-cascaded FK children so the delete can't dangle.
            # (Invoices are already excluded by _base_query.)
            db.query(ICalEvent).filter(ICalEvent.job_id == j.id).update(
                {ICalEvent.job_id: None}, synchronize_session=False)
            db.query(Activity).filter(Activity.job_id == j.id).update(
                {Activity.job_id: None}, synchronize_session=False)
            db.query(Message).filter(Message.job_id == j.id).update(
                {Message.job_id: None}, synchronize_session=False)
            db.delete(j)
            db.flush()
            sp.commit()
            deleted_ids.append(j.id)
        except IntegrityError:
            sp.rollback()
            skipped.append(j.id)
    if deleted_ids:
        db.commit()
    return {"deleted": len(deleted_ids), "skipped": len(skipped),
            "deleted_ids": deleted_ids}
