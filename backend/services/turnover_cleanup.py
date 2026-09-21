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
                              property_id: Optional[int] = None,
                              batch_size: int = 200,
                              max_delete: Optional[int] = None) -> dict:
    """Hard-delete the cancelled turnover ghosts. Human-confirmed only.

    Commits in batches — a flapping feed can leave *thousands* of ghosts on one
    property (observed: 6,400+), and a single end-of-run commit would lose
    everything if the request timed out mid-sweep. Each batch that commits stays
    deleted, so a re-run simply continues (the query only ever returns rows still
    present).

    `max_delete` caps how many are removed in ONE call, so the caller can keep
    each request well inside the client's 15s timeout and loop until `remaining`
    is 0 — the front end does exactly this, showing a live count. `remaining` is
    how many purgeable ghosts are still present after this call.

    Returns {deleted, skipped, remaining}."""
    deleted = 0
    skipped_ids: list = []
    while max_delete is None or deleted < max_delete:
        q = _base_query(db, org_id, property_id)
        if skipped_ids:
            # Rows we couldn't delete (an unexpected FK child) would otherwise
            # reappear every loop — exclude them so the sweep terminates.
            q = q.filter(Job.id.notin_(skipped_ids))
        lim = batch_size if max_delete is None else min(batch_size, max_delete - deleted)
        jobs = q.limit(lim).all()
        if not jobs:
            break
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
                deleted += 1
            except IntegrityError:
                sp.rollback()
                skipped_ids.append(j.id)
        db.commit()
    remaining_q = _base_query(db, org_id, property_id)
    if skipped_ids:
        remaining_q = remaining_q.filter(Job.id.notin_(skipped_ids))
    remaining = remaining_q.count()
    return {"deleted": deleted, "skipped": len(skipped_ids), "remaining": remaining}
