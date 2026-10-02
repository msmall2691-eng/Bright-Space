"""Data Doctor — a read-only, whole-schema data-quality scan.

The sibling of the recurring-series health scan (`services/recurring_guards.py`,
`GET /api/recurring/cleanup/health`), generalised to the core operational
tables: clients, properties, quotes, jobs, invoices, opportunities, leads. It
answers "is the data underneath the app actually sound?" — dangling foreign
keys, rows missing a column the model swears is NOT NULL (prod schema drift is
real here), money that reads wrong, totals that don't add up, lifecycle rows
stuck in a state they should have left, and duplicate contacts.

Two hard rules, both load-bearing:

  * **It never writes.** Every function here only reads. Fixing anything goes
    through the normal endpoints with a human confirming — same contract as
    recurring-doctor, and it keeps us on the right side of scheduling-invariants
    R7 (no automated deletion of canonical work). `destructive` is stamped on a
    finding only to warn a human which fixes would remove data.
  * **It does not re-diagnose recurring series.** Duplicate/ended-but-active/
    ghost *series* belong to recurring-doctor and its scan; doubling up would
    just produce two disagreeing reports. Data Doctor stays on the rows
    recurring-doctor doesn't look at.

`run_data_scan(db, org_id=...)` returns a plain dict (wire-shape decoupled from
the ORM, like the rest of the app). When `org_id` is an int the scan is scoped
to that workspace (tolerating legacy NULL-org rows, exactly like the app's
queries); pass `org_id=None` for an all-workspaces sweep (the ops script does
this).
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database.models import (
    Client, Property, Quote, Job, Invoice, Opportunity, LeadIntake,
)
from utils.dates import business_today
from utils.phone import phone_tail

logger = logging.getLogger(__name__)

# How many offending row ids to carry back per finding. Enough to start fixing
# by hand; not so many that a badly-drifted table returns a megabyte of ids.
_SAMPLE_CAP = 25

_SEVERITY_RANK = {"error": 0, "warn": 1, "info": 2}


def _org_filter(model, org_id: Optional[int]):
    """MT-2 scope for the primary table of a check. None → no filter (sweep all
    workspaces). An int → that workspace, tolerating legacy NULL-org rows the
    same way the app's own queries do."""
    if org_id is None:
        return None
    return or_(model.org_id == org_id, model.org_id.is_(None))


def _finding(code, severity, table, message, ids, suggestion, destructive=False):
    ids = list(ids)
    return {
        "code": code,
        "severity": severity,
        "table": table,
        "message": message,
        "count": len(ids),
        "sample_ids": ids[:_SAMPLE_CAP],
        "truncated": len(ids) > _SAMPLE_CAP,
        "suggestion": suggestion,
        # The scan itself never deletes; this only tells a human which fix would.
        "destructive": destructive,
    }


# ── Orphaned foreign keys ────────────────────────────────────────────────────
# A FK column that points at a row that no longer exists. SQLite (dev/tests) and
# some legacy prod rows don't enforce every FK, so these really do occur, and a
# dangling id 500s the page that tries to join through it.

_ORPHAN_CHECKS = [
    # (child model, fk column, parent model, code, human label, severity)
    (Job, Job.property_id, Property, "orphan_job_property", "jobs point at a missing property", "error"),
    (Job, Job.client_id, Client, "orphan_job_client", "jobs point at a missing client", "error"),
    (Job, Job.quote_id, Quote, "orphan_job_quote", "jobs point at a missing quote", "warn"),
    (Quote, Quote.client_id, Client, "orphan_quote_client", "quotes point at a missing client", "error"),
    (Quote, Quote.property_id, Property, "orphan_quote_property", "quotes point at a missing property", "warn"),
    (Property, Property.client_id, Client, "orphan_property_client", "properties point at a missing client", "error"),
    (Invoice, Invoice.client_id, Client, "orphan_invoice_client", "invoices point at a missing client", "error"),
    (Opportunity, Opportunity.client_id, Client, "orphan_opportunity_client", "opportunities point at a missing client", "error"),
    (LeadIntake, LeadIntake.client_id, Client, "orphan_lead_client", "leads point at a missing client", "warn"),
]


def _check_orphans(db: Session, org_id: Optional[int], findings: list) -> None:
    for child, fk_col, parent, code, label, severity in _ORPHAN_CHECKS:
        q = (
            db.query(child.id)
            .outerjoin(parent, fk_col == parent.id)
            .filter(fk_col.isnot(None), parent.id.is_(None))
        )
        scope = _org_filter(child, org_id)
        if scope is not None:
            q = q.filter(scope)
        ids = [r[0] for r in q.limit(_SAMPLE_CAP + 1).all()]
        if ids:
            findings.append(_finding(
                code, severity, child.__tablename__,
                f"{len(ids)}{'+' if len(ids) > _SAMPLE_CAP else ''} {label}.",
                ids,
                "Relink the row to a real record, or remove it through the normal UI.",
            ))


# ── Missing-required (model says NOT NULL, the row has NULL) ──────────────────
# Prod has drifted from the models in a few known places (Job.property_id,
# Property.client_id). These are the ones that actually break things.

_REQUIRED_CHECKS = [
    (Job, Job.property_id, "job_no_property", "jobs have no property (model requires one)", "error"),
    (Property, Property.client_id, "property_no_client", "properties have no client (model requires one)", "error"),
    (Quote, Quote.client_id, "quote_no_client", "quotes have no client (model requires one)", "error"),
]


def _check_required(db: Session, org_id: Optional[int], findings: list) -> None:
    for model, col, code, label, severity in _REQUIRED_CHECKS:
        q = db.query(model.id).filter(col.is_(None))
        scope = _org_filter(model, org_id)
        if scope is not None:
            q = q.filter(scope)
        ids = [r[0] for r in q.limit(_SAMPLE_CAP + 1).all()]
        if ids:
            findings.append(_finding(
                code, severity, model.__tablename__,
                f"{len(ids)}{'+' if len(ids) > _SAMPLE_CAP else ''} {label}.",
                ids,
                "Set the missing link; a NULL here is schema drift the model forbids.",
            ))


# ── Money anomalies ──────────────────────────────────────────────────────────
# Money is float dollars across the whole app (not integer cents — a known,
# app-wide convention, out of scope to change here). So we don't flag the type;
# we flag values that are simply wrong: negative money, and stored totals that
# don't equal subtotal + tax − discount (a rounding drift or a stale write).

_MONEY_TOLERANCE = 0.01  # a cent, to absorb float noise in the total check

_NEGATIVE_MONEY_CHECKS = [
    (Quote, [Quote.subtotal, Quote.tax, Quote.discount, Quote.total], "quote_negative_money", "quotes"),
    (Invoice, [Invoice.subtotal, Invoice.tax, Invoice.discount, Invoice.total], "invoice_negative_money", "invoices"),
    (Job, [Job.price], "job_negative_price", "jobs"),
    (Opportunity, [Opportunity.amount], "opportunity_negative_amount", "opportunities"),
]


def _check_negative_money(db: Session, org_id: Optional[int], findings: list) -> None:
    for model, cols, code, label in _NEGATIVE_MONEY_CHECKS:
        neg = or_(*[c < 0 for c in cols])
        q = db.query(model.id).filter(neg)
        scope = _org_filter(model, org_id)
        if scope is not None:
            q = q.filter(scope)
        ids = [r[0] for r in q.limit(_SAMPLE_CAP + 1).all()]
        if ids:
            findings.append(_finding(
                code, "warn", model.__tablename__,
                f"{len(ids)}{'+' if len(ids) > _SAMPLE_CAP else ''} {label} have a negative money value.",
                ids,
                "Correct the amount; money is never negative on these records.",
            ))


def _check_total_mismatch(db: Session, org_id: Optional[int], findings: list) -> None:
    """Rows whose stored total != subtotal + tax − discount. Runs on quotes and
    invoices, both of which carry all four columns."""
    for model, code, label in [(Quote, "quote_total_mismatch", "quotes"),
                               (Invoice, "invoice_total_mismatch", "invoices")]:
        computed = (func.coalesce(model.subtotal, 0)
                    + func.coalesce(model.tax, 0)
                    - func.coalesce(model.discount, 0))
        drift = func.abs(func.coalesce(model.total, 0) - computed)
        q = db.query(model.id).filter(drift > _MONEY_TOLERANCE)
        scope = _org_filter(model, org_id)
        if scope is not None:
            q = q.filter(scope)
        ids = [r[0] for r in q.limit(_SAMPLE_CAP + 1).all()]
        if ids:
            findings.append(_finding(
                code, "warn", model.__tablename__,
                f"{len(ids)}{'+' if len(ids) > _SAMPLE_CAP else ''} {label} whose total ≠ subtotal + tax − discount.",
                ids,
                "Re-save the record to recompute the total, or correct the line items.",
            ))


# ── Lifecycle / stale ────────────────────────────────────────────────────────
# Rows stuck in a state they should have left. Dates are compared against the
# Maine-local business date, not the server's UTC date (business_today), so the
# late-evening off-by-one can't produce false positives.

def _check_lifecycle(db: Session, org_id: Optional[int], findings: list) -> None:
    today = business_today()

    # Quote past its valid_until but still open (should read expired).
    q = db.query(Quote.id).filter(
        Quote.valid_until.isnot(None),
        Quote.valid_until < today,
        Quote.status.in_(("sent", "viewed")),
    )
    scope = _org_filter(Quote, org_id)
    if scope is not None:
        q = q.filter(scope)
    ids = [r[0] for r in q.limit(_SAMPLE_CAP + 1).all()]
    if ids:
        findings.append(_finding(
            "quote_expired_still_open", "info", "quotes",
            f"{len(ids)}{'+' if len(ids) > _SAMPLE_CAP else ''} quotes are past their valid-until date but still open.",
            ids,
            "Let them expire (they read as live on the pipeline until then), or re-quote.",
        ))

    # Job scheduled in the past but never closed out.
    q = db.query(Job.id).filter(
        Job.scheduled_date.isnot(None),
        Job.scheduled_date < today,
        Job.status.in_(("scheduled", "dispatched", "in_progress")),
    )
    scope = _org_filter(Job, org_id)
    if scope is not None:
        q = q.filter(scope)
    ids = [r[0] for r in q.limit(_SAMPLE_CAP + 1).all()]
    if ids:
        findings.append(_finding(
            "job_past_not_closed", "warn", "jobs",
            f"{len(ids)}{'+' if len(ids) > _SAMPLE_CAP else ''} jobs are dated in the past but still open (not completed/cancelled).",
            ids,
            "Complete or cancel them so the board and payroll reflect reality.",
        ))


# ── Duplicate contacts ───────────────────────────────────────────────────────
# Duplicate CLIENTS only (duplicate recurring series belong to recurring-doctor).
# Email is grouped in SQL (case-insensitive); phone is grouped in Python using
# the app's own phone_tail so "(207) 555-1212" and "+12075551212" collapse.

def _check_duplicate_clients(db: Session, org_id: Optional[int], findings: list) -> None:
    scope = _org_filter(Client, org_id)

    # Email — case-insensitive exact match.
    key = func.lower(func.trim(Client.email))
    q = db.query(key).filter(Client.email.isnot(None), func.trim(Client.email) != "")
    if scope is not None:
        q = q.filter(scope)
    dup_emails = [r[0] for r in q.group_by(key).having(func.count() > 1).limit(_SAMPLE_CAP + 1).all()]
    if dup_emails:
        findings.append(_finding(
            "duplicate_client_email", "warn", "clients",
            f"{len(dup_emails)}{'+' if len(dup_emails) > _SAMPLE_CAP else ''} email addresses are shared by more than one client.",
            dup_emails,  # the shared emails, not ids — the merge is keyed on these
            "Merge the duplicates (scripts/merge_duplicate_clients.py, or the Clients UI).",
        ))

    # Phone — normalise in Python via phone_tail (last 10 digits).
    pq = db.query(Client.id, Client.phone).filter(Client.phone.isnot(None), func.trim(Client.phone) != "")
    if scope is not None:
        pq = pq.filter(scope)
    groups: dict[str, list] = {}
    for cid, phone in pq.all():
        tail = phone_tail(phone)
        if tail:
            groups.setdefault(tail, []).append(cid)
    dup_phone_ids = [cid for ids in groups.values() if len(ids) > 1 for cid in ids]
    if dup_phone_ids:
        findings.append(_finding(
            "duplicate_client_phone", "warn", "clients",
            f"{len([g for g in groups.values() if len(g) > 1])} phone numbers are shared by more than one client.",
            dup_phone_ids,
            "Merge the duplicates (scripts/merge_duplicate_clients.py, or the Clients UI).",
        ))


# ── Tenancy hygiene ──────────────────────────────────────────────────────────
# Legacy rows with a NULL org_id. The app tolerates them (the scope filters are
# NULL-tolerant on purpose), but every such row is visible to every workspace,
# so on a multi-workspace install they want backfilling. Info-level, and only
# meaningful on an all-workspaces sweep.

_NULL_ORG_TABLES = [Client, Property, Quote, Job, Invoice, Opportunity, LeadIntake]


def _check_null_org(db: Session, org_id: Optional[int], findings: list) -> None:
    if org_id is not None:
        return  # a scoped scan already only sees this org's rows (plus NULL) — not the point
    per_table = []
    total = 0
    for model in _NULL_ORG_TABLES:
        n = db.query(func.count(model.id)).filter(model.org_id.is_(None)).scalar() or 0
        if n:
            per_table.append(f"{model.__tablename__}={n}")
            total += n
    if total:
        findings.append(_finding(
            "null_org_rows", "info", "(multiple)",
            f"{total} rows across core tables have no workspace (org_id NULL): {', '.join(per_table)}.",
            [],
            "Fine on a single-workspace install; backfill before onboarding a second workspace.",
        ))


_CHECKS = [
    _check_orphans,
    _check_required,
    _check_negative_money,
    _check_total_mismatch,
    _check_lifecycle,
    _check_duplicate_clients,
    _check_null_org,
]


def run_data_scan(db: Session, org_id: Optional[int] = None) -> dict:
    """Run every read-only check and return a structured report.

    ``org_id`` int → scope to that workspace (NULL-org-tolerant). ``None`` →
    sweep all workspaces (ops script). One misbehaving check never sinks the
    whole scan: it's logged and recorded as its own error finding, so the report
    always comes back.
    """
    findings: list = []
    for check in _CHECKS:
        try:
            check(db, org_id, findings)
        except Exception as exc:  # a scan must never 500 the caller
            logger.exception("data_doctor check %s failed", getattr(check, "__name__", check))
            findings.append(_finding(
                "scan_check_failed", "error", "(scan)",
                f"A check ({getattr(check, '__name__', 'unknown')}) errored and was skipped: {exc}",
                [], "This is a bug in the scan itself, not your data — report it.",
            ))

    findings.sort(key=lambda f: (_SEVERITY_RANK.get(f["severity"], 9), f["code"]))
    summary = {"error": 0, "warn": 0, "info": 0}
    for f in findings:
        summary[f["severity"]] = summary.get(f["severity"], 0) + 1
    return {
        "generated_at": business_today().isoformat(),
        "org_id": org_id,
        "healthy": not findings,
        "summary": {**summary, "total_findings": len(findings)},
        "findings": findings,
    }
