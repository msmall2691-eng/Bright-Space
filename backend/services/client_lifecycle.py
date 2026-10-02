"""Client + property archive lifecycle (Jobber-style).

Archiving a client (or one property) takes it out of every active workflow in
ONE action, while keeping all history and invoices intact and staying one-click
reversible. This is the cascade engine; the routers just call it (keeps the
cascade out of router.py — R6 spirit).

Authority model (scheduling-invariants Rule 0): BrightBase Jobs are canonical,
the iCal feed is an inbox. So archive may STOP generation, CANCEL-pending future
visits, DISMISS future bookings and CLOSE offers — but it never hard-deletes a
Job (R7). Only an explicit force-delete removes rows, and that lives in the
router with its own confirm.

What archiving a client does (a property is the same, scoped to one property):
  • its properties      → archived (active=False + archived_at)
  • recurring series    → stopped (active=False + cancelled_at) — generation off
  • FUTURE visits       → cancel-pending (status='cancelled' + note + GCal
                          release + offers closed). Past/completed untouched (R7).
  • turnover bookings   → future ones dismissed so the generator won't recreate
                          them (composes with migration 118's dismissal marker)
  • open marketplace    → offers closed via close_offer (never reassigned)
  • open quotes         → archived (recoverable)
  • deals / invoices    → UNTOUCHED (deals keep their stage; invoices stay
                          payable — money/history is preserved)

Unarchive reverses the reversible half: the client + properties come back and
the feed resumes for future bookings. It deliberately does NOT resurrect
cancelled visits or recurring series (R7 — regeneration is a human act; the
operator re-adds or uses the existing "rebuild turnovers" action).
"""
from datetime import datetime, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Client, Property, Job, RecurringSchedule, ICalEvent, Quote
from utils.dates import business_today

_ACTIVE_JOB_STATES = ("scheduled", "unscheduled", "in_progress")
_OPEN_QUOTE_STATES = ("draft", "sent")


def _dismiss_tag(kind: str, entity_id: int) -> str:
    """Stable label written to ICalEvent.dismissed_by so unarchive can undo
    exactly the bookings THIS archive dismissed — and never a turnover the
    office deleted by hand (that carries 'office delete')."""
    return f"archive:{kind}:{entity_id}"


# ── building blocks ───────────────────────────────────────────────────────────
def _future_active_jobs(db: Session, *, client_id=None, property_id=None):
    q = db.query(Job).filter(
        Job.scheduled_date.isnot(None),
        Job.scheduled_date >= business_today(),
        Job.status.in_(_ACTIVE_JOB_STATES),
    )
    if client_id is not None:
        q = q.filter(Job.client_id == client_id)
    if property_id is not None:
        q = q.filter(Job.property_id == property_id)
    return q.all()


def _cancel_future_jobs(db: Session, jobs, note: str) -> int:
    # Lazy import: the cancel side-effects (GCal release + close_offer + clear a
    # displaced agreed rate) live beside the recurring paths; reuse them so a
    # visit cancelled by archive behaves exactly like every other cancel.
    from modules.recurring.router import _cancel_side_effects
    n = 0
    for j in jobs:
        j.status = "cancelled"
        j.notes = (j.notes or "") + f"\n[{note}]"
        _cancel_side_effects(db, j)
        n += 1
    return n


def _stop_recurring(db: Session, *, client_id=None, property_id=None) -> int:
    q = db.query(RecurringSchedule).filter(RecurringSchedule.active.is_(True))
    if client_id is not None:
        q = q.filter(RecurringSchedule.client_id == client_id)
    if property_id is not None:
        q = q.filter(RecurringSchedule.property_id == property_id)
    now = datetime.now(timezone.utc)
    n = 0
    for s in q.all():
        s.active = False
        if s.cancelled_at is None:
            s.cancelled_at = now
        n += 1
    return n


def _dismiss_future_bookings(db: Session, property_ids, tag: str) -> int:
    if not property_ids:
        return 0
    today = business_today().isoformat()
    q = db.query(ICalEvent).filter(
        ICalEvent.property_id.in_(property_ids),
        ICalEvent.dismissed_at.is_(None),
        ICalEvent.checkout_date >= today,   # checkout_date is a 'YYYY-MM-DD' string
    )
    now = datetime.now(timezone.utc)
    n = 0
    for e in q.all():
        e.dismissed_at = now
        e.dismissed_by = tag
        n += 1
    return n


def _undismiss_bookings(db: Session, property_ids, tag: str) -> int:
    if not property_ids:
        return 0
    # Only clear the bookings THIS archive dismissed — never one the office
    # deleted individually (tag 'office delete').
    q = db.query(ICalEvent).filter(
        ICalEvent.property_id.in_(property_ids),
        ICalEvent.dismissed_by == tag,
    )
    n = 0
    for e in q.all():
        e.dismissed_at = None
        e.dismissed_by = None
        n += 1
    return n


def _archive_open_quotes(db: Session, client_id: int) -> int:
    now = datetime.now(timezone.utc)
    q = db.query(Quote).filter(
        Quote.client_id == client_id,
        Quote.archived_at.is_(None),
        Quote.status.in_(_OPEN_QUOTE_STATES),
    )
    n = 0
    for quote in q.all():
        quote.archived_at = now
        n += 1
    return n


# ── previews (for the "show the count first" confirm) ─────────────────────────
def preview_client_archive(db: Session, client: Client) -> dict:
    prop_ids = [p.id for p in client.properties if p.active]
    return {
        "client_id": client.id,
        "properties": len(prop_ids),
        "upcoming_visits": len(_future_active_jobs(db, client_id=client.id)),
        "recurring_series": db.query(RecurringSchedule).filter(
            RecurringSchedule.client_id == client.id,
            RecurringSchedule.active.is_(True)).count(),
        "open_quotes": db.query(Quote).filter(
            Quote.client_id == client.id, Quote.archived_at.is_(None),
            Quote.status.in_(_OPEN_QUOTE_STATES)).count(),
    }


def preview_property_archive(db: Session, prop: Property) -> dict:
    return {
        "property_id": prop.id,
        "upcoming_visits": len(_future_active_jobs(db, property_id=prop.id)),
        "recurring_series": db.query(RecurringSchedule).filter(
            RecurringSchedule.property_id == prop.id,
            RecurringSchedule.active.is_(True)).count(),
    }


# ── client ────────────────────────────────────────────────────────────────────
def archive_client(db: Session, client: Client, actor_id=None) -> dict:
    """Archive a client and everything downstream. Idempotent-ish: re-archiving
    an already-archived client just re-runs the (now no-op) cascade. Commits."""
    now = datetime.now(timezone.utc)
    prop_ids = [p.id for p in client.properties]

    visits = _cancel_future_jobs(
        db, _future_active_jobs(db, client_id=client.id),
        note="Client archived — visit removed from the calendar")
    series = _stop_recurring(db, client_id=client.id)
    dismissed = _dismiss_future_bookings(db, prop_ids, _dismiss_tag("client", client.id))
    quotes = _archive_open_quotes(db, client.id)

    # Archive the properties themselves (active=False is the predicate the ticks
    # + get_properties already honor; archived_at records the deliberate act).
    props = 0
    for p in client.properties:
        if p.active or p.archived_at is None:
            p.active = False
            if p.archived_at is None:
                p.archived_at = now
                p.archived_by = actor_id
            props += 1

    if client.archived_at is None:
        client.archived_at = now
        client.archived_by = actor_id
    db.commit()
    return {"client_id": client.id, "properties_archived": props,
            "visits_cancelled": visits, "recurring_stopped": series,
            "bookings_dismissed": dismissed, "quotes_archived": quotes}


def unarchive_client(db: Session, client: Client) -> dict:
    """Bring a client back: clear the archive marker, reactivate the properties,
    and resume the feed for future bookings. Does NOT resurrect cancelled visits
    or recurring series (R7 — a human re-adds those)."""
    prop_ids = [p.id for p in client.properties]
    restored = 0
    for p in client.properties:
        if p.archived_at is not None or not p.active:
            p.active = True
            p.archived_at = None
            p.archived_by = None
            restored += 1
    undismissed = _undismiss_bookings(db, prop_ids, _dismiss_tag("client", client.id))
    client.archived_at = None
    client.archived_by = None
    db.commit()
    return {"client_id": client.id, "properties_restored": restored,
            "bookings_resumed": undismissed}


# ── property ──────────────────────────────────────────────────────────────────
def archive_property(db: Session, prop: Property, actor_id=None) -> dict:
    now = datetime.now(timezone.utc)
    visits = _cancel_future_jobs(
        db, _future_active_jobs(db, property_id=prop.id),
        note="Property archived — visit removed from the calendar")
    series = _stop_recurring(db, property_id=prop.id)
    dismissed = _dismiss_future_bookings(db, [prop.id], _dismiss_tag("property", prop.id))
    prop.active = False
    if prop.archived_at is None:
        prop.archived_at = now
        prop.archived_by = actor_id
    db.commit()
    return {"property_id": prop.id, "visits_cancelled": visits,
            "recurring_stopped": series, "bookings_dismissed": dismissed}


def unarchive_property(db: Session, prop: Property) -> dict:
    undismissed = _undismiss_bookings(db, [prop.id], _dismiss_tag("property", prop.id))
    prop.active = True
    prop.archived_at = None
    prop.archived_by = None
    db.commit()
    return {"property_id": prop.id, "bookings_resumed": undismissed}
