"""Turnover-coverage computation: which upcoming guest checkouts have no
active turnover job.

Factored out of scheduler.turnover_coverage_tick so its two consumers — the
5:30am scheduler safety net and the owner-facing follow-up scan
(modules/ai/router._compute_followups) — share ONE definition of "covered".
Before this existed the daily tick computed coverage and only LOGGED it, so a
gap was invisible unless someone read Railway logs; the follow-up scan would
otherwise have re-implemented the checkout↔turnover matching and the two could
silently disagree (tick says all-clear while the alert list flags gaps, or the
reverse). Read-only: no feed fetch, no writes — safe to call from a request.

Lives in services/ (not scheduler.py) so importing it never drags in
APScheduler or the sync integrations; not in a router so the tick doesn't
import request-scoped modules (R6: routers route).
"""
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import ICalEvent, Job, Property, PropertyIcal
from utils.dates import business_today


def compute_turnover_coverage(db: Session, org_id: Optional[int] = None) -> dict:
    """Match every upcoming guest checkout to a live turnover job.

    Returns {properties_checked, missing_total, flagged: [{property_id,
    property, missing: [iso-date, ...], feed_errors?: [source, ...]}]}.

    A property is checked when it's active with at least one active iCal feed.
    "Expected" checkouts come from stored reservation ICalEvents (today or
    later); "covered" means a live (non-cancelled) str_turnover Job on that
    calendar date. A property with a failing/retrying feed is flagged even
    with no missing dates — a brand-new reservation won't be in ICalEvent yet,
    so stale "expected" data can't prove coverage (mirrors turnover_sweep):
    an outage must never produce a false all-clear while a turnover is
    actually missing.

    org_id: when given, restrict to that workspace (MT-3) with the same
    NULL-tolerant filter the routers use (legacy rows carry org_id NULL and
    belong to the default workspace). The scheduler tick passes None — it
    audits every tenant in one pass.
    """
    today = business_today().isoformat()

    def _d(x):
        return x if isinstance(x, str) else (x.isoformat() if x else None)

    prop_q = (
        db.query(Property.id)
        .join(PropertyIcal, PropertyIcal.property_id == Property.id)
        .filter(Property.active == True, PropertyIcal.active == True)  # noqa: E712
    )
    if org_id is not None:
        prop_q = prop_q.filter(or_(Property.org_id == org_id, Property.org_id.is_(None)))
    prop_ids = [r[0] for r in prop_q.distinct().all()]

    flagged = []
    total_missing = 0
    for pid in prop_ids:
        prop = db.query(Property).filter(Property.id == pid).first()
        expected = {
            _d(e.checkout_date) for e in db.query(ICalEvent).filter(
                ICalEvent.property_id == pid).all()
            if getattr(e, "event_type", "reservation") == "reservation"
            and e.checkout_date and _d(e.checkout_date) >= today
        }
        active = {
            _d(j.scheduled_date) for j in db.query(Job).filter(
                Job.property_id == pid,
                Job.job_type == "str_turnover",
                Job.status.notin_(["cancelled"]),
                Job.scheduled_date.isnot(None),
            ).all()
            if j.scheduled_date and _d(j.scheduled_date) >= today
        }
        missing = sorted(expected - active)
        failed_feeds = [
            (pi.source or "feed") for pi in (prop.property_icals or [])
            if getattr(pi, "active", True) and pi.last_sync_status in ("failed", "retrying")
        ]
        if missing or failed_feeds:
            name = prop.name if prop else str(pid)
            total_missing += len(missing)
            entry = {"property_id": pid, "property": name, "missing": missing}
            if failed_feeds:
                entry["feed_errors"] = failed_feeds
            flagged.append(entry)

    return {
        "properties_checked": len(prop_ids),
        "missing_total": total_missing,
        "flagged": flagged,
    }
