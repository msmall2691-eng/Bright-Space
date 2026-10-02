"""Pipeline — the lead→cash spine as one prioritized list.

One screen, one fetch. Every lead, quote, job and invoice that needs a push to
move to its next stage, grouped by stage in pipeline order, each row carrying
the single next action. This is read-only aggregation — no mutation, no sync
(scheduling-invariants: nothing here writes canonical or projection state). The
actions are deep links into the page that owns that step; the "Book it" link
lands on the quote's booking flow, which no longer dead-ends on a missing
address.

Render-ready, like the Ops Board: every string is final and the frontend stays
a pure view. Helpers are shared with services/board_service so a pipeline row
and a board card format identically.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from database.models import LeadIntake, Quote, Job, Invoice
from utils.dates import business_today
from services.board_service import (
    _item, _link, _sort_items, _fmt_money, _client_name, _ago, _day_label,
    _fmt_time, _job_place,
)

# The pipeline is a worklist, not a full report: each stage shows the most
# pressing few and the row deep-links into the page that owns the whole set.
_PIPE_CAP = 8


def _add(stages: list, key: str, label: str, tone: str, items: list) -> None:
    """Append a stage only when it has rows — an empty stage renders nothing
    (owner rule: no permanent all-clear furniture). Rows sort most-urgent first
    within the stage via the shared severity order."""
    if items:
        ordered = _sort_items(items)
        stages.append({
            "key": key, "label": label, "tone": tone,
            "count": len(ordered), "items": ordered,
        })


def build_pipeline(db: Session, oid: int) -> dict:
    today = business_today()
    horizon = today + timedelta(days=14)
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))  # noqa: E731

    stages: list = []

    # ── 1. New requests — a lead that still needs a quote ────────────────────
    leads = (
        db.query(LeadIntake)
        .filter(org(LeadIntake), LeadIntake.status.in_(("new", "reviewed")))
        .order_by(LeadIntake.created_at.desc())
        .limit(_PIPE_CAP)
        .all()
    )
    lead_items = []
    for ld in leads:
        hot = (ld.priority or "normal") in ("high", "urgent")
        svc = (ld.requested_service or ld.service_type or "").strip()
        body = " · ".join(x for x in (svc, (ld.address or "").strip()) if x) \
            or (ld.message or "Wants a quote").strip()[:100]
        lead_items.append(_item(
            f"lead:{ld.id}", "watch" if hot else "info",
            ld.name or "New inquiry", body, _ago(ld.created_at),
            # Draft a real quote in one tap (AI-written from what they told us)
            # and land on it to review and send — the same endpoint the board
            # uses; its response href is what the page navigates to. It's a
            # button, not the row's tap target, so a stray tap can't spend an
            # AI call. "Open" (the link) is the row's safe default.
            actions=[
                {"label": "Draft a quote", "kind": "api", "method": "POST",
                 "endpoint": f"/api/ai/quote-from-lead/{ld.id}", "done": "Draft ready"},
                _link("Open", f"/requests/{ld.id}"),
            ],
        ))
    _add(stages, "new", "New requests", "indigo", lead_items)

    # ── 2. Quote out — sent/viewed, waiting on the customer ──────────────────
    sent = (
        db.query(Quote)
        .options(joinedload(Quote.client))
        .filter(org(Quote), Quote.status.in_(("sent", "viewed")))
        .order_by(Quote.sent_at.asc().nullslast())
        .limit(_PIPE_CAP)
        .all()
    )
    quote_items = []
    for q in sent:
        where = "viewed, not accepted" if q.viewed_at else "sent, not opened"
        quote_items.append(_item(
            f"quote:{q.id}", "info",
            _client_name(q) or (q.title or "Quote"),
            f"{_fmt_money(q.total)} · {where}", _ago(q.viewed_at or q.sent_at),
            actions=[_link("Open quote", f"/quotes/{q.id}")],
        ))
    _add(stages, "quoted", "Quote out", "indigo", quote_items)

    # ── 3. Ready to book — accepted, no job yet (the stranded pile) ──────────
    accepted = (
        db.query(Quote)
        .options(joinedload(Quote.client))
        .filter(org(Quote), Quote.status == "accepted")
        .order_by(Quote.accepted_at.asc().nullslast())
        .limit(_PIPE_CAP)
        .all()
    )
    book_items = []
    for q in accepted:
        book_items.append(_item(
            f"accepted:{q.id}", "watch",
            _client_name(q) or (q.title or "Quote"),
            f"{_fmt_money(q.total)} · accepted, not booked", _ago(q.accepted_at),
            # Book it leads; Archive is the quiet escape hatch for a dead or
            # test quote that will never become work (soft-delete — recoverable
            # — via the existing DELETE /api/quotes/{id}). Lets the stranded
            # pile be cleared from right here instead of a trip to each quote.
            actions=[
                _link("Book it", f"/quotes/{q.id}?book=1"),
                {
                    "label": "Archive", "kind": "api", "method": "DELETE",
                    "endpoint": f"/api/quotes/{q.id}",
                    "confirm": "Archive this quote? You can restore it later.",
                    "done": "Archived",
                },
            ],
        ))
    _add(stages, "accepted", "Ready to book", "amber", book_items)

    # ── 4. Booked — upcoming jobs (next two weeks) ───────────────────────────
    jobs = (
        db.query(Job)
        .options(joinedload(Job.property), joinedload(Job.client))
        .filter(
            org(Job),
            Job.scheduled_date >= today,
            Job.scheduled_date <= horizon,
            Job.status.in_(("scheduled", "in_progress")),
        )
        .order_by(Job.scheduled_date, Job.start_time)
        .limit(_PIPE_CAP)
        .all()
    )
    job_items = []
    for j in jobs:
        unassigned = not (j.cleaner_ids or [])
        st, et = _fmt_time(j.start_time), _fmt_time(j.end_time)
        span = f"{st}–{et}" if st and et else st
        meta = " · ".join(x for x in (_day_label(j.scheduled_date, today), span) if x)
        job_items.append(_item(
            f"job:{j.id}", "watch" if unassigned else "good",
            _client_name(j) or _job_place(j) or (j.title or "Job"),
            _job_place(j), meta,
            tags=([{"label": "Needs cleaner", "tone": "amber"}] if unassigned else []),
            actions=[_link("Open job", f"/jobs/{j.id}")],
        ))
    _add(stages, "booked", "Booked", "emerald", job_items)

    # ── 5. To send — a draft invoice (auto-created on completion) to send ────
    drafts = (
        db.query(Invoice)
        .options(joinedload(Invoice.client))
        .filter(org(Invoice), Invoice.status == "draft")
        .order_by(Invoice.created_at.desc())
        .limit(_PIPE_CAP)
        .all()
    )
    draft_items = []
    for inv in drafts:
        draft_items.append(_item(
            f"invoice:{inv.id}", "watch",
            _client_name(inv) or (inv.invoice_number or "Invoice"),
            f"{_fmt_money(inv.total)} · draft, not sent", _ago(inv.created_at),
            # Send emails the invoice to the customer — outward-facing, so it
            # takes a confirm. Defaults to the client's email on file; if there
            # is none the send fails and the row stays put with a toast.
            actions=[
                {"label": "Send", "kind": "api", "method": "POST",
                 "endpoint": f"/api/invoices/{inv.id}/send", "body": {"channel": "email"},
                 "confirm": "Email this invoice to the customer?", "done": "Sent"},
                _link("Open invoice", f"/invoices/{inv.id}"),
            ],
        ))
    _add(stages, "to_invoice", "To send", "amber", draft_items)

    # ── 6. Unpaid — sent/overdue invoices awaiting payment ───────────────────
    unpaid = (
        db.query(Invoice)
        .options(joinedload(Invoice.client))
        .filter(org(Invoice), Invoice.status.in_(("sent", "overdue")))
        .order_by(Invoice.created_at.desc())
        .limit(_PIPE_CAP)
        .all()
    )
    unpaid_items = []
    for inv in unpaid:
        overdue = inv.status == "overdue"
        unpaid_items.append(_item(
            f"unpaid:{inv.id}", "urgent" if overdue else "info",
            _client_name(inv) or (inv.invoice_number or "Invoice"),
            f"{_fmt_money(inv.total)} · {'overdue' if overdue else 'sent, awaiting payment'}",
            _ago(inv.created_at),
            # Mark paid records a manual payment in place (same endpoint the
            # board's overdue card uses); confirm-gated. Open to chase instead.
            actions=[
                {"label": "Mark paid", "kind": "api", "method": "POST",
                 "endpoint": f"/api/invoices/{inv.id}/pay", "body": {},
                 "confirm": "Mark this invoice paid?", "done": "Marked paid"},
                _link("Open invoice", f"/invoices/{inv.id}"),
            ],
        ))
    _add(stages, "unpaid", "Unpaid", "red", unpaid_items)

    return {"stages": stages, "total_open": sum(s["count"] for s in stages)}
