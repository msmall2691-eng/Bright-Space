"""What a subcontractor is owed, whether it went out, and how it gets there.

A sub is a VENDOR. That is not a wording preference — it is the whole point of
this file. Square's Labor timecard path carries hours at an hourly rate, which
is precisely the shape a subcontractor's pay must not have, so before this
module a sub's payment had no home at all: `marketplace_pay` was computed in
the payroll summary, folded into Gross Pay, dropped by the Square export, and
then read off a screen and typed into a bank somewhere by hand.

`sub_payouts` (migration 099) is the ledger that outlives whatever payment rail
gets chosen. The rail is deliberately an interface with one boring
implementation (manual/CSV), because the record of what was owed is the part
that must not be rewritten when the rail changes — and because a year-to-date
1099 total should be one query that starts accruing today, not archaeology next
January. The $600 threshold arrives mid-year.

IDEMPOTENCE IS THE SAFETY PROPERTY HERE. `generate` sits next to real money and
will be pressed twice — the same period re-run after a correction, a double tap
on a slow connection. UNIQUE (user_id, job_id) is what makes the second press a
no-op, and this module is written to lean on it rather than on the caller being
careful.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import date, datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database.models import Job, SubPayout, User
from services.claim_approval import agreed_with
from utils.dates import business_today, coerce_date

logger = logging.getLogger(__name__)

# A payout's life. `void` rather than a DELETE: a payout that was cancelled is
# a thing that happened, and a 1099 conversation in February is not the moment
# to discover a row was quietly removed in August.
STATUSES = ("due", "sent", "paid", "void")

# Statuses that represent money actually owed or gone out. `void` is excluded
# everywhere a total is computed — that is the only reason it exists.
LIVE_STATUSES = ("due", "sent", "paid")

# Jobs in these states have not been done, so there is nothing to pay for yet.
_UNEARNED_JOB_STATUSES = ("cancelled", "unscheduled")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _org_scope(model, org_id: int):
    return or_(model.org_id == org_id, model.org_id.is_(None))


# ── Finding the work ────────────────────────────────────────────────────────

def earned_jobs(db: Session, org_id: int, start: date, end: date) -> list:
    """Completed jobs in [start, end] that carry an agreed subcontractor rate.

    `agreed_rate` is the marker of a claim the office approved — the same field
    payroll's marketplace bucket reads (`modules/payroll/router.py`). Reading
    the same field rather than re-deriving from `job_claim_requests` is
    deliberate: a route job will also carry `agreed_rate` without ever having
    been a claim request, and it must be payable by exactly this path.
    """
    return (
        db.query(Job)
        .filter(_org_scope(Job, org_id),
                Job.agreed_rate.isnot(None),
                Job.agreed_rate > 0,
                Job.scheduled_date >= start,
                Job.scheduled_date <= end,
                Job.status == "completed")
        .order_by(Job.scheduled_date, Job.id)
        .all()
    )


def _users_by_cleaner_id(db: Session, org_id: int, cleaner_ids: Iterable[str]) -> dict:
    ids = [c for c in set(cleaner_ids) if c]
    if not ids:
        return {}
    rows = (db.query(User)
            .filter(User.cleaner_id.in_(ids), _org_scope(User, org_id))
            .all())
    return {u.cleaner_id: u for u in rows}


def preview(db: Session, org_id: int, start: date, end: date) -> dict:
    """What `generate` would do, without doing it.

    Split into `new` and `existing` so the office can press Generate on a
    period it already ran and see "nothing new" rather than wondering whether
    it just paid twice.
    """
    jobs = earned_jobs(db, org_id, start, end)
    users = _users_by_cleaner_id(db, org_id,
                                 (c for j in jobs for c in (j.cleaner_ids or [])))

    job_ids = [j.id for j in jobs]
    already = set()
    if job_ids:
        for p in (db.query(SubPayout)
                  .filter(SubPayout.job_id.in_(job_ids),
                          _org_scope(SubPayout, org_id))
                  .all()):
            already.add((p.user_id, p.job_id))

    new, existing, unmatched = [], [], []
    for j in jobs:
        amount = round(float(j.agreed_rate or 0.0), 2)
        for cid in (j.cleaner_ids or []):
            # ONE person agreed this price, and only they are owed it.
            #
            # This iterated every cleaner on the job and cut a full payout each,
            # which is the same bug #774 fixed in the payroll summary and the
            # Square export — in the one place that generates what a sub is
            # actually paid. Add an hourly employee to a $100 marketplace job
            # and they got a $100 vendor payout row, feeding a 1099 year-to-date
            # for a W-2 employee.
            #
            # A job never carries two APPROVED claims: approval auto-declines
            # every other pending request and closes the offer. So a second
            # name on a marketplace job is somebody the office added, and they
            # are on the clock, not on the price.
            if not agreed_with(j, cid):
                continue
            u = users.get(cid)
            if u is None:
                # A crew ID with no login: recorded as a problem, never as a
                # payout. A payout row needs a person to pay.
                unmatched.append({"job_id": j.id, "cleaner_id": cid,
                                  "scheduled_date": j.scheduled_date.isoformat()
                                  if j.scheduled_date else None})
                continue
            row = {
                "job_id": j.id,
                "user_id": u.id,
                "cleaner_id": cid,
                "name": u.full_name or u.email or cid,
                "amount": amount,
                "earned_on": j.scheduled_date.isoformat() if j.scheduled_date else None,
                "memo": (j.title or "") or f"Job #{j.id}",
            }
            (existing if (u.id, j.id) in already else new).append(row)

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "new": new,
        "new_total": round(sum(r["amount"] for r in new), 2),
        "existing": existing,
        "unmatched": unmatched,
    }


def generate(db: Session, org_id: int, start: date, end: date) -> dict:
    """Create `due` payouts for completed marketplace work in the period.

    Safe to run twice: the unique constraint is caught per row rather than
    per batch, so one already-paid job in the middle of a period does not
    abandon the twenty after it. Nothing here sends money — a `due` row is a
    statement about what is owed, and paying it is a separate, deliberate act.
    """
    # Each row gets its own SAVEPOINT. Without one, catching the IntegrityError
    # means db.rollback(), which unwinds the WHOLE session — every payout
    # already flushed ahead of the collision disappears, silently, while
    # `created` still counts them. A period where one job had been paid early
    # would then record only the jobs that came after it.
    plan = preview(db, org_id, start, end)
    now = _now()
    created = 0
    for r in plan["new"]:
        payout = SubPayout(
            org_id=org_id,
            user_id=r["user_id"],
            cleaner_id=r["cleaner_id"],
            job_id=r["job_id"],
            amount=r["amount"],
            status="due",
            memo=r["memo"],
            earned_on=coerce_date(r["earned_on"]),
            created_at=now,
            updated_at=now,
        )
        try:
            with db.begin_nested():
                db.add(payout)
            created += 1
        except IntegrityError:
            # Somebody else generated the same period between our read and our
            # write. The constraint is the authority, not the preview; only
            # this row is undone.
            logger.info("sub_payout already exists for user=%s job=%s",
                        r["user_id"], r["job_id"])
    db.commit()
    return {
        "created": created,
        "skipped_existing": len(plan["existing"]),
        "unmatched": plan["unmatched"],
        "total": round(sum(r["amount"] for r in plan["new"]), 2),
    }


# ── Reading the ledger ──────────────────────────────────────────────────────

def _payout_dict(p: SubPayout, name: Optional[str] = None) -> dict:
    return {
        "id": p.id,
        "user_id": p.user_id,
        "cleaner_id": p.cleaner_id,
        "name": name,
        "job_id": p.job_id,
        "amount": round(float(p.amount or 0.0), 2),
        "status": p.status,
        "method": p.method,
        "external_ref": p.external_ref,
        "memo": p.memo,
        "earned_on": p.earned_on.isoformat() if p.earned_on else None,
        "paid_at": p.paid_at.isoformat() if p.paid_at else None,
    }


def list_payouts(db: Session, org_id: int, *, start: Optional[date] = None,
                 end: Optional[date] = None, user_id: Optional[int] = None,
                 status: Optional[str] = None) -> list:
    q = db.query(SubPayout).filter(_org_scope(SubPayout, org_id))
    if start is not None:
        q = q.filter(SubPayout.earned_on >= start)
    if end is not None:
        q = q.filter(SubPayout.earned_on <= end)
    if user_id is not None:
        q = q.filter(SubPayout.user_id == user_id)
    if status:
        q = q.filter(SubPayout.status == status)
    rows = q.order_by(SubPayout.earned_on.desc(), SubPayout.id.desc()).all()
    names = {u.id: (u.full_name or u.email)
             for u in db.query(User).filter(
                 User.id.in_([r.user_id for r in rows] or [0])).all()}
    return [_payout_dict(r, names.get(r.user_id)) for r in rows]


def year_to_date(db: Session, org_id: int, year: Optional[int] = None) -> dict:
    """Per-sub totals for the tax year, grouped by `earned_on`.

    Grouped by when the work happened, not when the money moved: a January
    payment for December work belongs to December, and that is the difference
    between a correct 1099 and an argument.

    `void` payouts are excluded; everything else counts, because a sub who has
    been told they're owed $700 has been owed $700 whether or not the cheque
    has cleared. The threshold flag is advisory — a real filing decision is the
    accountant's, and this is here so nobody is surprised by it in January.
    """
    year = year or business_today().year
    rows = (db.query(SubPayout)
            .filter(_org_scope(SubPayout, org_id),
                    SubPayout.status.in_(LIVE_STATUSES),
                    SubPayout.earned_on >= date(year, 1, 1),
                    SubPayout.earned_on <= date(year, 12, 31))
            .all())
    by_user: dict = {}
    for r in rows:
        e = by_user.setdefault(r.user_id, {
            "user_id": r.user_id, "cleaner_id": r.cleaner_id, "name": None,
            "jobs": 0, "total": 0.0, "paid": 0.0, "outstanding": 0.0,
        })
        e["jobs"] += 1
        amt = float(r.amount or 0.0)
        e["total"] += amt
        if r.status == "paid":
            e["paid"] += amt
        else:
            e["outstanding"] += amt

    if by_user:
        for u in db.query(User).filter(User.id.in_(list(by_user))).all():
            by_user[u.id]["name"] = u.full_name or u.email

    out = []
    for e in by_user.values():
        for k in ("total", "paid", "outstanding"):
            e[k] = round(e[k], 2)
        # 1099-NEC reporting threshold. Advisory only — see the docstring.
        e["over_1099_threshold"] = e["total"] >= 600.0
        out.append(e)
    out.sort(key=lambda r: -r["total"])
    return {
        "year": year,
        "subs": out,
        "total": round(sum(e["total"] for e in out), 2),
        "outstanding": round(sum(e["outstanding"] for e in out), 2),
    }


def mark(db: Session, org_id: int, payout_ids: list, status: str, *,
         method: Optional[str] = None, external_ref: Optional[str] = None) -> dict:
    """Move payouts along the ledger. The only writer of `paid_at`.

    A payout that has already been marked `paid` is not re-stamped: the date
    money left is a fact, and a second click on the button should not move it.
    """
    if status not in STATUSES:
        raise ValueError(f"unknown payout status: {status}")
    rows = (db.query(SubPayout)
            .filter(SubPayout.id.in_(payout_ids or []),
                    _org_scope(SubPayout, org_id))
            .all())
    now = _now()
    for r in rows:
        r.status = status
        r.updated_at = now
        if method:
            r.method = method
        if external_ref:
            r.external_ref = external_ref
        if status == "paid" and r.paid_at is None:
            r.paid_at = now
    db.commit()
    return {"updated": len(rows), "status": status}


# ── The payment rail ────────────────────────────────────────────────────────
#
# One interface, one implementation. This is not speculative generality: the
# rail is genuinely undecided (cheque now, ACH or a bill-pay provider later),
# and the thing that must not move when it changes is the ledger above. Putting
# the seam here means a future rail implements `send` and touches nothing else.
#
# A rail NEVER writes payout rows. It returns what happened and the caller
# records it, so a rail that half-succeeds cannot leave the ledger claiming
# money went out that didn't.

class PayoutRail:
    """How money actually reaches a subcontractor."""

    name = "abstract"
    #: True when `send` moves money by itself. A manual rail does not — it
    #: produces the paperwork a human acts on, so its payouts become `sent`,
    #: never `paid`, until somebody confirms.
    settles = False

    def send(self, db: Session, org_id: int, payouts: list) -> dict:
        raise NotImplementedError


class ManualRail(PayoutRail):
    """Produce a CSV; a human pays from it.

    This is how TMCC actually pays today, so it is the honest default rather
    than a placeholder. It marks payouts `sent` and not `paid` for a reason
    worth stating: this code cannot know whether the cheque was written. Only a
    person can say that, and `mark(..., "paid")` is where they say it.
    """

    name = "manual"
    settles = False

    COLUMNS = ("payout_id", "name", "cleaner_id", "earned_on", "job_id",
               "amount", "memo")

    def render_csv(self, rows: list) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(self.COLUMNS)
        for r in rows:
            w.writerow([r.get("id"), r.get("name") or "", r.get("cleaner_id") or "",
                        r.get("earned_on") or "", r.get("job_id") or "",
                        f"{float(r.get('amount') or 0.0):.2f}", r.get("memo") or ""])
        return buf.getvalue()

    def send(self, db: Session, org_id: int, payouts: list) -> dict:
        ids = [p["id"] for p in payouts]
        csv_text = self.render_csv(payouts)
        mark(db, org_id, ids, "sent", method=self.name)
        return {
            "rail": self.name,
            "settled": False,
            "count": len(ids),
            "total": round(sum(float(p.get("amount") or 0.0) for p in payouts), 2),
            "csv": csv_text,
        }


_RAILS = {ManualRail.name: ManualRail}


def get_rail(name: Optional[str] = None) -> PayoutRail:
    """The configured rail. Unknown names fall back to manual rather than
    raising — a misconfigured setting should not make it impossible to pay
    anyone."""
    cls = _RAILS.get((name or "").strip().lower() or ManualRail.name)
    if cls is None:
        logger.warning("unknown payout rail %r — falling back to manual", name)
        cls = ManualRail
    return cls()
