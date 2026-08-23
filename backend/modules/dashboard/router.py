"""
Dashboard aggregate endpoints.

The dashboard home screen previously fetched the full quotes list (limit=500),
the full intake list (limit=200) and the active-clients list purely to count
rows and sum totals on the client. This endpoint computes those numbers with
indexed SQL aggregates in one round trip — no large payloads, no client-side
counting. The dashboard still fetches row-level detail (invoices for AR aging,
jobs/conversations for the schedule + attention list) separately, since those
need the actual records.

/owner adds the numbers an owner actually steers by — quote close rate,
recurring monthly revenue estimate, revenue by service, AR aging buckets,
and top clients. Same pre-computed shape so the Owner Dashboard page only
does presentation.
"""
from datetime import datetime, timedelta, date, timezone
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import (
    Quote, LeadIntake, Client, Invoice, Job, RecurringSchedule,
)
from modules.auth.router import require_role, current_org_id, resolve_org_id, get_current_user
from utils.dates import business_today
from services.board_service import build_board

router = APIRouter()


@router.get("/board", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def dashboard_board(db: Session = Depends(get_db), org_id: int = Depends(current_org_id),
                    user=Depends(get_current_user)):
    """Unified Ops Board payload — stat tiles, integration chips, per-severity
    filter counts, and the six triage sections — in one org-scoped round trip.
    Backs the iOS-style board at /dashboard (see services/board_service.py)."""
    oid = resolve_org_id(org_id, db)
    # Viewers can see the board but not act — the mutation endpoints require
    # admin/manager, so drop the one-click api actions rather than surface
    # buttons that deterministically 403 (member acts like manager).
    can_act = getattr(user, "role", None) in ("admin", "manager", "member")
    return build_board(db, oid, can_act=can_act)


@router.get("/summary", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def dashboard_summary(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Pre-computed dashboard KPIs: quote funnel/pipeline, new leads, active clients.

    Mirrors the derivations the frontend used to run over the full lists:
      pipeline_value = Σ total where status in (sent, draft)
      awaiting       = sent + viewed          (quotes out for reply)
      changes        = changes_requested
      to_schedule    = accepted
      quoted         = sent + viewed + changes_requested  (funnel "Quoted")
      won            = converted                          (funnel "Won")
    """
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    # One grouped pass over quotes → count + total per status.
    rows = (
        db.query(Quote.status, func.count(Quote.id), func.coalesce(func.sum(Quote.total), 0.0))
        .filter(org_scope(Quote))
        .group_by(Quote.status)
        .all()
    )
    by_status = {status: (count, total) for status, count, total in rows}

    def n(*statuses):
        return sum(by_status.get(s, (0, 0.0))[0] for s in statuses)

    def amt(*statuses):
        return sum(by_status.get(s, (0, 0.0))[1] for s in statuses)

    # Pending = leads not yet triaged. "received" was queried here but no code
    # ever writes it to a lead (dead vocabulary, P4 audit) — dropped so this
    # counts the states that actually exist: "new" and NULL (public submits).
    new_leads = (
        db.query(func.count(LeadIntake.id))
        .filter(
            org_scope(LeadIntake),
            or_(LeadIntake.status == "new", LeadIntake.status.is_(None)),
        )
        .scalar()
    ) or 0

    active_clients = (
        db.query(func.count(Client.id))
        .filter(org_scope(Client), Client.status == "active")
        .scalar()
    ) or 0

    return {
        "quotes": {
            "pipeline_value": round(amt("sent", "draft"), 2),
            "sent": n("sent"),
            "draft": n("draft"),
            "awaiting": n("sent", "viewed"),
            "changes": n("changes_requested"),
            "to_schedule": n("accepted"),
            "quoted": n("sent", "viewed", "changes_requested"),
            "accepted": n("accepted"),
            "won": n("converted"),
        },
        "new_leads": new_leads,
        "active_clients": active_clients,
    }


_WEEKS_PER_MONTH = 52.0 / 12.0
_DAYS_PER_MONTH = 30.0


def _monthly_job_estimate(sched) -> float:
    """Estimate the number of jobs a RecurringSchedule generates per month.

    Mirrors the cadence logic in `modules.recurring.router.generate_dates()`
    so every frequency that actually produces jobs also contributes to MRR.
    The audit-first version only priced `weekly`/`biweekly`/`monthly` and
    silently counted `daily`, `every_3_weeks`, and `every_4_weeks` schedules
    as `schedules_unpriced` — real MRR was under-reported.

    - `monthly` → 1.0 (day_of_month once per calendar month).
    - `daily`   → 30 / interval_weeks (interval_weeks is reused as the day
      step here; the recurring router does the same trick). If specific
      weekdays are set, scale by (days_selected / 7).
    - anything else (weekly, biweekly, every_3_weeks, every_4_weeks, …) →
      days_per_week × (52/12) / interval_weeks. `interval_weeks` carries
      the actual cadence: weekly=1, biweekly=2, every_3_weeks=3, etc.
    """
    freq = (sched.frequency or "").lower()
    if freq == "monthly":
        return 1.0

    # Count effective days-of-week. Mirrors _effective_days in the recurring
    # router: prefer days_of_week (cleaned), fall back to the legacy
    # day_of_week column, default to Monday.
    days_of_week = sched.days_of_week
    if isinstance(days_of_week, list) and days_of_week:
        cleaned_days = sorted({
            int(d) for d in days_of_week
            if isinstance(d, (int, float)) and 0 <= int(d) <= 6
        })
    else:
        cleaned_days = []
    days_per_week = len(cleaned_days) if cleaned_days else 1

    if freq == "daily":
        step = max(1, int(sched.interval_weeks or 1))
        base = _DAYS_PER_MONTH / step
        if cleaned_days:
            return base * days_per_week / 7.0
        return base

    interval = max(1, int(sched.interval_weeks or 1))
    return days_per_week * _WEEKS_PER_MONTH / interval


def _ar_aging_bucket(due_date_str: str | None, today: date) -> str | None:
    """Given a YYYY-MM-DD due_date, return the aging bucket. Buckets follow
    the industry 30/60/90 convention plus a `current` bucket for invoices
    that aren't past due yet — those are normal current receivables, not
    stale money.

    Returns None ONLY when the due_date is missing or malformed; those
    genuinely-uncategorizable invoices land in the caller's `unbucketed`
    bucket so an operator can spot the data-quality problem. Previously
    both "no due date" and "not yet due" collapsed into None, which made
    the UI mislabel current receivables as missing-date errors (Codex
    review on #519).
    """
    if not due_date_str:
        return None
    try:
        due = datetime.strptime(due_date_str[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None
    days = (today - due).days
    if days < 1:
        return "current"               # due today or later — not past due
    if days <= 30:
        return "0_30"
    if days <= 60:
        return "31_60"
    if days <= 90:
        return "61_90"
    return "90_plus"


@router.get("/owner", dependencies=[Depends(require_role("admin", "manager"))])
def owner_dashboard(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Owner-view KPIs — the numbers Meg actually steers by (audit §1).

    Returns close rate, an MRR estimate from active recurring schedules,
    revenue by service over the last 90 days, AR aging buckets, and top
    clients by paid revenue. All computed in indexed SQL passes so the
    Owner Dashboard page only does presentation.

    Not exposed to viewers — owner-facing financials are admin/manager only.
    """
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))
    today = business_today()
    now = datetime.utcnow()
    window_90d_start = now - timedelta(days=90)

    # ── Close rate (last 90 days) ─────────────────────────────────────────
    # Cohort-by-send-date: of the quotes SENT to a customer during the
    # window, what share have since converted. Filtering on Quote.sent_at
    # (not Quote.created_at) matters because a quote can sit in `draft`
    # for weeks before it's actually delivered — using created_at would
    # bin sent-today-but-drafted-months-ago quotes outside the window and
    # under-report recent activity.
    close_rows = (
        db.query(Quote.status, func.count(Quote.id))
        .filter(
            org_scope(Quote),
            Quote.sent_at.isnot(None),
            Quote.sent_at >= window_90d_start,
        )
        .group_by(Quote.status)
        .all()
    )
    close_counts = {status: count for status, count in close_rows}
    quotes_sent = sum(close_counts.values())
    quotes_won = close_counts.get("converted", 0)
    close_rate_pct = round(quotes_won / quotes_sent * 100, 1) if quotes_sent else None

    # ── MRR estimate ─────────────────────────────────────────────────────
    # For each ACTIVE recurring schedule with a linked quote, multiply the
    # quote total by the schedule's jobs-per-month estimate — see
    # `_monthly_job_estimate` for the cadence math (mirrors generate_dates).
    # Schedules missing a quote/total are surfaced as `unpriced` so the
    # owner can see what's excluded from the MRR figure.
    mrr_cents = 0
    priced = 0
    unpriced = 0
    schedules = (
        db.query(RecurringSchedule)
        .filter(org_scope(RecurringSchedule), RecurringSchedule.active.is_(True))
        .all()
    )
    # Batch-fetch every linked quote in one query instead of one round trip per
    # schedule (was N+1). Org-scope the read EXPLICITLY: a schedule's quote_id is
    # not validated against the schedule's org at write time, so filtering by id
    # alone would let another tenant's quote total leak into this org's MRR
    # wherever RLS isn't in force (e.g. SQLite). org_scope(Quote) makes the
    # isolation real in the query; Postgres RLS remains the backstop.
    quote_ids = {s.quote_id for s in schedules if s.quote_id}
    quotes_by_id = {}
    if quote_ids:
        quotes_by_id = {
            q.id: q for q in db.query(Quote).filter(org_scope(Quote), Quote.id.in_(quote_ids)).all()
        }
    for s in schedules:
        if not s.quote_id:
            unpriced += 1
            continue
        quote = quotes_by_id.get(s.quote_id)
        if not quote or not quote.total:
            unpriced += 1
            continue
        factor = _monthly_job_estimate(s)
        if factor <= 0:
            unpriced += 1
            continue
        mrr_cents += int(round(quote.total * factor * 100))
        priced += 1

    # ── Revenue by service (last 90 days) ────────────────────────────────
    # Joined via Invoice → Job so we can group by the actual delivered
    # service, not what was quoted. paid_at is authoritative here — an
    # invoice can be marked paid before its due_date rolls over.
    # LEFT OUTER JOIN (not inner): Invoice.job_id is optional (invoices can be
    # billed straight against a client/opportunity with no scheduled Job), and
    # an inner join here silently dropped every such paid invoice from the
    # 90-day total — "Revenue Paid" reading $0 despite real paid invoices.
    revenue_rows = (
        db.query(
            Job.job_type,
            func.count(Invoice.id),
            func.coalesce(func.sum(Invoice.total), 0.0),
        )
        .select_from(Invoice)
        .outerjoin(Job, Invoice.job_id == Job.id)
        .filter(
            org_scope(Invoice),
            Invoice.status == "paid",
            Invoice.paid_at.isnot(None),
            Invoice.paid_at >= window_90d_start,
        )
        .group_by(Job.job_type)
        .all()
    )
    revenue_by_service = [
        {"service_type": svc or "unknown", "invoice_count": int(count), "total": round(float(total), 2)}
        for svc, count, total in revenue_rows
    ]
    revenue_by_service.sort(key=lambda r: r["total"], reverse=True)

    # ── AR aging ─────────────────────────────────────────────────────────
    # 30/60/90 buckets over unpaid invoices. `due_date` is a string column
    # (see models.py), so we parse in Python — the volume is small enough
    # that iterating is fine and it keeps the bucket math testable without
    # relying on DB-specific date functions.
    aging = {
        "current": {"count": 0, "total": 0.0},
        "0_30": {"count": 0, "total": 0.0},
        "31_60": {"count": 0, "total": 0.0},
        "61_90": {"count": 0, "total": 0.0},
        "90_plus": {"count": 0, "total": 0.0},
        "unbucketed": {"count": 0, "total": 0.0},
    }
    unpaid = (
        db.query(Invoice.total, Invoice.due_date)
        .filter(org_scope(Invoice), Invoice.status.in_(("sent", "overdue")))
        .all()
    )
    for total, due_date_str in unpaid:
        bucket = _ar_aging_bucket(due_date_str, today)
        if bucket is None:
            aging["unbucketed"]["count"] += 1
            aging["unbucketed"]["total"] += float(total or 0.0)
        else:
            aging[bucket]["count"] += 1
            aging[bucket]["total"] += float(total or 0.0)
    for b in aging.values():
        b["total"] = round(b["total"], 2)

    # ── Top clients by paid revenue (last 90 days) ───────────────────────
    top_rows = (
        db.query(
            Client.id, Client.name,
            func.count(Invoice.id),
            func.coalesce(func.sum(Invoice.total), 0.0),
        )
        .join(Invoice, Invoice.client_id == Client.id)
        .filter(
            org_scope(Invoice),
            Invoice.status == "paid",
            Invoice.paid_at.isnot(None),
            Invoice.paid_at >= window_90d_start,
        )
        .group_by(Client.id, Client.name)
        .order_by(func.sum(Invoice.total).desc())
        .limit(10)
        .all()
    )
    top_clients = [
        {
            "client_id": cid,
            "client_name": name,
            "invoice_count": int(count),
            "total": round(float(total), 2),
        }
        for cid, name, count, total in top_rows
    ]

    return {
        "as_of": today.isoformat(),
        "window_days": 90,
        "close_rate": {
            "quotes_sent": quotes_sent,
            "quotes_won": quotes_won,
            "rate_pct": close_rate_pct,
        },
        "mrr": {
            "estimate_cents": mrr_cents,
            "schedules_priced": priced,
            "schedules_unpriced": unpriced,
        },
        "revenue_by_service": revenue_by_service,
        "ar_aging": aging,
        "top_clients": top_clients,
    }


# ── Owner-analytics widgets (Owner Dashboard) ───────────────────────────────
#
# Aggregation math lives in modules/dashboard/analytics.py — these endpoints
# only resolve the org and pass parameters through. Both compute on request
# (no background ticks, R1) and return plain dicts.


@router.get("/property-economics", dependencies=[Depends(require_role("admin", "manager"))])
def property_economics_endpoint(
    window_days: int = Query(90, ge=1, le=3650),
    limit: int = Query(8, ge=1, le=50),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """"Am I making money on this house" — per-property paid/invoiced revenue
    (Invoice → Job → Property), completed-visit count, crew hours from the
    native time clock, and effective $/hr, top N by paid revenue.

    Admin/manager only, matching /owner: per-property financials are
    owner-facing money, not something a viewer login needs."""
    from modules.dashboard.analytics import property_economics
    return property_economics(db, resolve_org_id(org_id, db),
                              window_days=window_days, limit=limit)


@router.get("/week-capacity", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def week_capacity_endpoint(
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Booked job hours vs available crew hours for the current (Mon-anchored)
    week, with a per-day split — the "how packed is this week" number. No
    financials, so viewers may read it (same gate as /summary)."""
    from modules.dashboard.analytics import week_capacity
    return week_capacity(db, resolve_org_id(org_id, db))


# ── Intake → Quote funnel ───────────────────────────────────────────────────
#
# A cohort funnel anchored on the REQUEST (LeadIntake), not a status snapshot:
# for every request created in the window we follow its linked quote as far as
# it got, so the stages are cumulative and monotonic
# (Requests ≥ Quoted ≥ Sent ≥ Viewed ≥ Accepted ≥ Won). This answers "of the
# leads we got, how many turned into money, and where do we lose them?" —
# which the status-snapshot /summary can't, because it buckets each quote by
# its *current* status only.

@router.get("/funnel", dependencies=[Depends(require_role("admin", "manager"))])
def funnel_dashboard(
    days: int = Query(30, ge=1, le=3650),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Intake→quote conversion funnel over the last ``days`` days.
    Admin/manager only (revenue). The rules live in
    modules.dashboard.analytics.lead_funnel so Home's chart and this page can
    never disagree about what "quoted" or "won" means."""
    from modules.dashboard.analytics import lead_funnel
    return lead_funnel(db, resolve_org_id(org_id, db), days=days)

