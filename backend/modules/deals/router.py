"""Unified deal read-model — the board's single data source (P4).

Requests and Pipeline are two phases of one lifecycle: the pre-triage *inbox*
(un-converted ``LeadIntake`` rows) and the *deal* (``Opportunity`` rows, the
spine every quote/job/invoice already FKs back to). This endpoint unions them
into one flat list of "deal cards" so the redesigned board can render the whole
continuum — ``inbox → new → qualified → quoted → won / lost`` — from a single
fetch, without the frontend stitching two shapes together.

Read-only and additive: no model owns a "deal card"; it's projected here.
Org-scoping reuses the existing ``current_org_id`` dependency + the same
permissive ``org_id == X OR org_id IS NULL`` filter the rest of the app uses,
so ``lead_intakes`` and ``opportunities`` RLS both apply — no new tenant table.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload, selectinload

from database.db import get_db
from database.models import LeadIntake, Opportunity, Quote
from modules.auth.router import require_role, current_org_id, resolve_org_id
from utils.deal_stage import STAGE_RANK, QUOTE_STATUS_STAGE

router = APIRouter()

# Opportunity stages this endpoint understands as "deal" stages (everything
# except the derived `inbox`, which only un-triaged leads occupy).
_OPP_STAGES = {"new", "qualified", "quoted", "won", "lost"}


def _lead_amount(lead):
    """A lead's headline number: the instant-quote estimate midpoint, if any."""
    lo, hi = getattr(lead, "estimate_min", None), getattr(lead, "estimate_max", None)
    if lo is not None and hi is not None:
        return round((lo + hi) / 2, 2)
    return hi if hi is not None else lo


def _most_advanced_quote_status(quotes):
    """The status of the furthest-along quote on a deal — ranked by the stage
    each quote status maps to (a converted quote outranks a draft one), tie-
    broken by id so the newest wins. None when the deal has no quotes."""
    best, best_rank = None, -1
    for q in quotes or []:
        rank = STAGE_RANK.get(QUOTE_STATUS_STAGE.get(q.status, "quoted"), 0)
        if rank >= best_rank:
            best, best_rank = q, rank
    return best.status if best else None


def _job_state(jobs):
    """Coarsest single signal of where a deal's work sits, furthest-along first.
    `done` > `scheduled` > None (no schedulable job yet). (The old intermediate
    'dispatched' state read Connecteam shift ids — gone with the removal; a
    scheduled+assigned job IS dispatched now, the crew sees it on My Day.)"""
    done = scheduled = False
    for j in jobs or []:
        if j.status == "cancelled":
            continue
        if j.status == "completed":
            done = True
        if getattr(j, "scheduled_date", None):
            scheduled = True
    if done:
        return "done"
    if scheduled:
        return "scheduled"
    return None


def _age_days(created_at):
    if not created_at:
        return None
    from datetime import datetime
    return max(0, (datetime.utcnow() - created_at).days)


def _lead_card(lead, quote=None):
    return {
        "kind": "lead",
        # Prefixed id so lead and deal cards never collide as React keys.
        "id": f"lead-{lead.id}",
        "ref_id": lead.id,
        "lead_id": lead.id,
        "opportunity_id": None,
        "stage": "inbox",
        "client_id": lead.client_id,
        "client_name": lead.name,
        "title": (lead.service_type or "Request").title(),
        "amount": _lead_amount(lead),
        "service_type": lead.service_type,
        "quote_status": getattr(quote, "status", None) if quote else None,
        "job_state": None,
        "source": lead.source,
        "owner": getattr(lead, "assigned_to", None),
        "priority": getattr(lead, "priority", "normal"),
        "age_days": _age_days(lead.created_at),
        "created_at": lead.created_at.isoformat() if lead.created_at else None,
    }


def _deal_card(opp):
    return {
        "kind": "deal",
        "id": f"deal-{opp.id}",
        "ref_id": opp.id,
        "lead_id": None,
        "opportunity_id": opp.id,
        "stage": opp.stage,
        "client_id": opp.client_id,
        "client_name": opp.client.name if opp.client else None,
        "title": opp.title,
        "amount": opp.amount,
        "service_type": opp.service_type,
        "quote_status": _most_advanced_quote_status(getattr(opp, "quotes", None)),
        "job_state": _job_state(getattr(opp, "jobs", None)),
        "source": None,
        "owner": opp.owner,
        "priority": "normal",
        "age_days": _age_days(opp.created_at),
        "created_at": opp.created_at.isoformat() if opp.created_at else None,
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_deals(
    stage: Optional[str] = None,
    owner: Optional[str] = None,
    service_type: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """The whole deal board in one call: inbox leads + opportunities as cards.

    `stage` narrows to one column — `inbox` returns only un-triaged leads, an
    opportunity stage returns only those deals; omitted returns both. Results
    are merged newest-first and capped at `limit` (board views load the whole
    pipeline, like the Pipeline kanban's limit=200).
    """
    oid = resolve_org_id(org_id, db)
    want_leads = stage in (None, "inbox")
    want_deals = stage is None or stage in _OPP_STAGES

    cards = []

    if want_leads:
        # Inbox = leads not yet triaged into a deal and not archived.
        lq = (
            db.query(LeadIntake)
            .filter(
                or_(LeadIntake.org_id == oid, LeadIntake.org_id.is_(None)),
                LeadIntake.opportunity_id.is_(None),
                or_(LeadIntake.status != "archived", LeadIntake.status.is_(None)),
            )
        )
        if service_type:
            lq = lq.filter(LeadIntake.service_type == service_type)
        if owner:
            lq = lq.filter(LeadIntake.assigned_to == owner)
        leads = lq.order_by(LeadIntake.created_at.desc()).limit(limit).all()
        # Batch-load the leads' quotes (one query) so quote_status needs no N+1.
        quote_ids = {l.converted_quote_id for l in leads if getattr(l, "converted_quote_id", None)}
        quotes_by_id = {}
        if quote_ids:
            for qt in db.query(Quote).filter(Quote.id.in_(quote_ids)).all():
                quotes_by_id[qt.id] = qt
        cards.extend(_lead_card(l, quotes_by_id.get(getattr(l, "converted_quote_id", None))) for l in leads)

    if want_deals:
        # Eager-load everything the card touches so serializing N deals is a
        # handful of queries, not 1 + N×2 (client + quotes + jobs per row).
        oq = (
            db.query(Opportunity)
            .options(
                joinedload(Opportunity.client),
                selectinload(Opportunity.quotes),
                selectinload(Opportunity.jobs),
            )
            .filter(or_(Opportunity.org_id == oid, Opportunity.org_id.is_(None)))
        )
        if stage in _OPP_STAGES:
            oq = oq.filter(Opportunity.stage == stage)
        if owner:
            oq = oq.filter(Opportunity.owner == owner)
        if service_type:
            oq = oq.filter(Opportunity.service_type == service_type)
        opps = oq.order_by(Opportunity.created_at.desc()).limit(limit).all()
        cards.extend(_deal_card(o) for o in opps)

    if search:
        s = search.lower()
        cards = [c for c in cards if s in (c["title"] or "").lower() or s in (c["client_name"] or "").lower()]

    # Merge newest-first across both sources, then cap.
    cards.sort(key=lambda c: c["created_at"] or "", reverse=True)
    return cards[:limit]
