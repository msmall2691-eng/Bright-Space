"""Keep the Pipeline kanban populated by mapping the lead → quote → job funnel
onto Opportunity (deal) rows.

We keep **one active deal per client** — reused until it's won or lost — so the
board reflects real work without spawning a card per quote. Helpers are
best-effort: a board/timeline write must never break the underlying lead/quote
operation (same contract as utils.activity_logger).
"""
import logging

from sqlalchemy.orm import Session

from database.models import Opportunity
from utils.activity_logger import log_activity

logger = logging.getLogger(__name__)

# Forward order of the pipeline; won/lost are terminal (rank highest so we never
# regress out of them).
_RANK = {"new": 0, "qualified": 1, "quoted": 2, "won": 3, "lost": 3}


def _active_opp(db: Session, client_id: int):
    return (
        db.query(Opportunity)
        .filter(Opportunity.client_id == client_id, Opportunity.stage.notin_(("won", "lost")))
        .order_by(Opportunity.created_at.desc())
        .first()
    )


def ensure_opportunity(db: Session, *, client_id, org_id=None, stage="new",
                       title=None, amount=None, service_type=None, owner=None):
    """Return the client's active opportunity, creating one if none exists.
    Never raises into the caller."""
    if not client_id:
        return None
    try:
        opp = _active_opp(db, client_id)
        if opp:
            return opp
        opp = Opportunity(
            client_id=client_id, org_id=org_id, stage=stage,
            title=title or "Opportunity", amount=amount,
            service_type=service_type, owner=owner,
        )
        db.add(opp)
        db.flush()
        log_activity(
            db, "opportunity_created", client_id=client_id, opportunity_id=opp.id,
            summary=f"Opportunity created: {opp.title}", extra_data={"stage": stage, "auto": True},
        )
        return opp
    except Exception as e:  # pragma: no cover - safety net
        logger.warning("ensure_opportunity failed for client %s: %s", client_id, e)
        return None


def advance_opportunity(db: Session, opp, stage, *, amount=None, close_date=None, lost_reason=None):
    """Move an opp forward (won/lost always allowed; never regress). Updates
    amount/close_date/lost_reason when given. Never raises into the caller."""
    if opp is None:
        return None
    try:
        old = opp.stage
        if stage in ("won", "lost") or _RANK.get(stage, 0) > _RANK.get(old, 0):
            opp.stage = stage
            if old != stage:
                log_activity(
                    db, "opportunity_stage_changed", client_id=opp.client_id, opportunity_id=opp.id,
                    summary=f"Stage: {old} → {stage}",
                    extra_data={"old_stage": old, "new_stage": stage, "auto": True},
                )
        if amount is not None:
            opp.amount = amount
        if close_date is not None:
            opp.close_date = close_date
        if lost_reason is not None:
            opp.lost_reason = lost_reason
        return opp
    except Exception as e:  # pragma: no cover - safety net
        logger.warning("advance_opportunity failed for opp %s: %s", getattr(opp, "id", "?"), e)
        return opp


def advance_for_quote(db: Session, quote, stage, **kwargs):
    """Advance the opportunity linked to a quote (no-op if the quote isn't linked)."""
    opp_id = getattr(quote, "opportunity_id", None)
    if not opp_id:
        return None
    opp = db.query(Opportunity).filter(Opportunity.id == opp_id).first()
    return advance_opportunity(db, opp, stage, **kwargs)


# Quote status → pipeline stage, for the one-time backfill of existing rows.
_QUOTE_STATUS_STAGE = {
    "draft": "quoted", "sent": "quoted", "viewed": "quoted", "changes_requested": "quoted",
    "accepted": "quoted", "converted": "won", "declined": "lost", "expired": "lost",
    "archived": "lost",
}


def backfill_opportunities(db: Session) -> dict:
    """Create one Opportunity per client that has quotes/leads but no deal yet,
    link those quotes/leads (and their jobs) to it, and set the stage from the
    most-advanced quote. Idempotent — re-running creates nothing new.

    Returns a small report dict (created/linked counts). Used by migration 030
    and exercised directly in tests.
    """
    from database.models import Quote, Job, LeadIntake, Client

    report = {"created": 0, "quotes_linked": 0, "leads_linked": 0, "jobs_linked": 0}

    # Clients that have at least one quote or lead.
    client_ids = {
        cid for (cid,) in db.query(Quote.client_id).filter(Quote.client_id.isnot(None)).distinct()
    } | {
        cid for (cid,) in db.query(LeadIntake.client_id).filter(LeadIntake.client_id.isnot(None)).distinct()
    }

    for cid in client_ids:
        opp = _active_opp(db, cid)
        if opp is None:
            # Pick the most-advanced quote to seed stage + amount.
            quotes = db.query(Quote).filter(Quote.client_id == cid).all()
            best_stage, best_amount, svc, title = "new", None, None, None
            for q in quotes:
                st = _QUOTE_STATUS_STAGE.get(q.status, "quoted")
                if _RANK.get(st, 0) >= _RANK.get(best_stage, 0):
                    best_stage = st
                    best_amount = q.total
                    svc = q.service_type
                    title = q.title
            client = db.query(Client).filter(Client.id == cid).first()
            opp = Opportunity(
                client_id=cid, org_id=getattr(client, "org_id", None), stage=best_stage,
                title=title or (client.name if client else "Opportunity"),
                amount=best_amount, service_type=svc,
            )
            db.add(opp)
            db.flush()
            report["created"] += 1

        # Link unlinked quotes / leads / jobs for this client.
        for q in db.query(Quote).filter(Quote.client_id == cid, Quote.opportunity_id.is_(None)).all():
            q.opportunity_id = opp.id
            report["quotes_linked"] += 1
        for ld in db.query(LeadIntake).filter(LeadIntake.client_id == cid, LeadIntake.opportunity_id.is_(None)).all():
            ld.opportunity_id = opp.id
            report["leads_linked"] += 1
        for j in db.query(Job).filter(Job.client_id == cid, Job.opportunity_id.is_(None)).all():
            j.opportunity_id = opp.id
            report["jobs_linked"] += 1

    return report
