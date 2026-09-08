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
January. The reporting threshold arrives mid-year.

IDEMPOTENCE IS THE SAFETY PROPERTY HERE. `generate` sits next to real money and
will be pressed twice — the same period re-run after a correction, a double tap
on a slow connection. UNIQUE (user_id, job_id) is what makes the second press a
no-op, and this module is written to lean on it rather than on the caller being
careful.
"""
from __future__ import annotations

import csv
import hashlib
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

# The ledger's legal moves. `mark()` is the only writer of status, and without
# this it moved a row anywhere in STATUSES — which is money:
#   * paid -> due/sent re-enters the payable batch and pays somebody TWICE
#     (the paid_at guard kept the date but not the row out of the next send);
#   * void -> anything resurrects a payout for work that was cancelled;
#   * paid -> void says money that left the account never did, so the 1099 and
#     the reconciliation disagree.
# So the two settled/closed states are TERMINAL, and everything else moves
# forward (a settling rail pays `due` straight to `paid`) or to `void`.
# Re-marking a row to the status it already holds is an idempotent no-op — the
# office clicking "paid" twice, or correcting a reference — not a transition,
# and never re-stamps paid_at.
_ALLOWED_TRANSITIONS = {
    "due":  {"sent", "paid", "void"},
    "sent": {"paid", "void"},
    "paid": set(),   # money left — a fact, not a step to walk back
    "void": set(),   # cancelled stays cancelled
}

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

def _payout_dict(p: SubPayout, name: Optional[str] = None, *,
                 direct_deposit: bool = False) -> dict:
    return {
        "id": p.id,
        # Whether THIS person can be paid electronically today. Carried on the
        # row rather than looked up per render, so the office can see at a
        # glance which half of a batch a bank rail can actually take — the
        # answer differs per sub and changes whenever one of them finishes
        # onboarding.
        "direct_deposit": bool(direct_deposit),
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
    people = {u.id: u for u in db.query(User).filter(
        User.id.in_([r.user_id for r in rows] or [0])).all()}
    out = []
    for r in rows:
        u = people.get(r.user_id)
        out.append(_payout_dict(
            r, (u.full_name or u.email) if u else None,
            # The CACHED flag, written only by the Stripe webhook. Asking
            # Stripe per row would be one API call per ledger line on a screen
            # that lists a whole pay period (brightbase-economy).
            direct_deposit=bool(u and u.stripe_account_id
                                and u.stripe_payouts_enabled)))
    return out


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
    from services.bench import form_1099_threshold
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
        #
        # READ FROM THE YEAR, NOT A LITERAL. This was `>= 600.0`, which was
        # right until the One Big Beautiful Bill Act raised section 6041(a) to
        # $2,000 for payments made after 31 December 2025. `bench.py` already
        # had the year-aware helper; this second call site was missed when it
        # was written, so the bench roster and the payout ledger have been
        # answering the same question differently — and this one has been
        # flagging subs for 2026 who owe no form at all.
        #
        # Measured against the year the payouts are FOR, which is the `year`
        # this function was asked about, not today's.
        e["over_1099_threshold"] = e["total"] >= form_1099_threshold(year)
        out.append(e)
    out.sort(key=lambda r: -r["total"])
    return {
        "year": year,
        # The figure the flag was measured against, so the screen can say
        # WHICH threshold it means instead of printing "$600" forever. That
        # literal outlived its own truth in three places already; a number the
        # caller is handed cannot drift from the number the caller compares.
        "threshold": form_1099_threshold(year),
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

    # Validate every transition BEFORE writing anything: a batch that mixes a
    # legal move with an illegal one is all-or-nothing, so the office is told
    # which row is wrong rather than half the batch moving and half not. A row
    # already in the target status is a no-op, not a transition, and is allowed.
    illegal = [r for r in rows
               if (r.status or "due") != status
               and status not in _ALLOWED_TRANSITIONS.get(r.status or "due", set())]
    if illegal:
        raise ValueError(
            "illegal payout transition(s): "
            + ", ".join(f"#{r.id} {r.status}→{status}" for r in illegal))

    now = _now()
    for r in rows:
        # A reference or method can be corrected on a row that is already there
        # (a fixed cheque number on a paid row), so those always apply.
        if method:
            r.method = method
        if external_ref:
            r.external_ref = external_ref
        if (r.status or "due") == status:
            # Idempotent: the status stands and paid_at — the date money left —
            # is not re-stamped by a second click.
            continue
        r.status = status
        r.updated_at = now
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

class PayoutRailUnavailable(RuntimeError):
    """The rail cannot pay right now, and no money moved.

    Raised BEFORE anything is sent — an unconfigured rail, or a balance that
    cannot cover the batch. A rail that has already moved some money never
    raises; it reports per row, because a batch that half-worked is a fact the
    caller has to be told, not an error to swallow.
    """


class PayoutRail:
    """How money actually reaches a subcontractor."""

    name = "abstract"
    #: True when `send` moves money by itself. A manual rail does not — it
    #: produces the paperwork a human acts on, so its payouts become `sent`,
    #: never `paid`, until somebody confirms.
    settles = False

    def status(self, db: Session, org_id: int) -> dict:
        """Whether this rail can pay right now, in words for the office.

        Called for the SELECTED rail only. A rail that has to ask a payments
        API to answer this is one network round trip per screen load, which is
        acceptable once and would not be acceptable per rail.
        """
        return {"name": self.name, "settles": self.settles,
                "ready": True, "detail": None}

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
    label = "By hand, from a CSV"

    def status(self, db: Session, org_id: int) -> dict:
        return {"name": self.name, "settles": self.settles, "ready": True,
                "detail": "Sending downloads a list. Pay from it, then mark "
                          "them paid here."}

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


class StripeRail(PayoutRail):
    """Money actually leaves, per payout row, into the sub's own account.

    `settles = True` and payouts land on `paid`, and that word is doing precise
    work. A successful transfer means the money left TMCC's Stripe balance and
    belongs to the subcontractor — which is the fact this ledger records. It is
    NOT the same instant it appears in their bank: Stripe deposits from their
    balance to their bank on its own schedule. So "paid" here is true of the
    business, and the crew screen says the other half out loud rather than
    letting a sub read "paid" and go looking at their bank the same afternoon.

    ONE TRANSFER PER PAYOUT ROW, never one per batch. A batched transfer saves
    nothing (Stripe charges no per-transfer fee) and costs the only thing that
    matters here: a $250 transfer covering four jobs cannot be traced back to
    the job it paid for, reversed for one of them, or reconciled against the
    ledger. Row-for-row means `external_ref` is a real answer to "which
    payment was that".

    THE THING THIS FILE IS MOST CAREFUL ABOUT is not paying twice.

    Nothing that touched the network can be trusted to have failed. Before any
    call, every row in the batch is stamped `method = "stripe"` in one commit.
    A row that comes back `due`, stamped, with no `external_ref` is a row whose
    outcome was never learned — the process died, or the connection did — and
    it is refused on the next attempt and reported for a human to look up in
    Stripe. Refusing to pay somebody until a person checks is recoverable in a
    minute. Paying them twice is a phone call and a favour.

    Stripe's idempotency key covers the narrow case where the crash happened
    between the transfer and the ledger write: replaying inside 24 hours
    returns the same transfer instead of making another. It is a second belt,
    not the mechanism — the key is forgotten after a day, and a retry on day
    two would pay again.
    """

    name = "stripe"
    settles = True
    label = "Stripe — straight to their bank"

    def status(self, db: Session, org_id: int) -> dict:
        from integrations import stripe_connect as sc

        base = {"name": self.name, "settles": self.settles}
        if not sc.configured():
            return {**base, "ready": False,
                    "detail": "Stripe isn't connected. Add STRIPE_SECRET_KEY "
                              "and the account webhook, then this can pay."}
        bal = sc.platform_balance()
        if bal is None:
            # UNKNOWN, not zero. A balance read that failed must not read as
            # "you have no money" on a screen somebody makes decisions from.
            return {**base, "ready": True,
                    "detail": "Couldn't read your Stripe balance just now."}
        avail = bal["available_cents"] / 100.0
        pending = bal["pending_cents"] / 100.0
        detail = f"${avail:,.2f} available to send"
        if pending:
            detail += f" · ${pending:,.2f} still clearing"
        return {**base, "ready": True, "detail": detail,
                "available": round(avail, 2), "pending": round(pending, 2)}

    def _key(self, payout: SubPayout) -> str:
        """Stable per payout, and different after a reversal.

        A reversed transfer puts the row back to `due` and keeps the old
        transfer id for the audit trail. Re-sending inside 24 hours with the
        original key would hand back that same reversed transfer and mark the
        row paid on money that came home, so the previous attempt's id is
        folded into the key.
        """
        key = f"bb-payout-{payout.id}"
        if payout.external_ref:
            key += "-r" + hashlib.sha1(
                payout.external_ref.encode("utf-8")).hexdigest()[:8]
        return key

    def send(self, db: Session, org_id: int, payouts: list) -> dict:
        from integrations import stripe_connect as sc

        if not sc.configured():
            raise PayoutRailUnavailable(
                "Stripe isn't connected yet, so nothing can be sent that way.")

        ids = [p["id"] for p in payouts]
        rows = (db.query(SubPayout)
                .filter(SubPayout.id.in_(ids or [0]), _org_scope(SubPayout, org_id))
                .all())
        people = {u.id: u for u in db.query(User).filter(
            User.id.in_([r.user_id for r in rows] or [0])).all()}
        named = {p["id"]: (p.get("name") or p.get("cleaner_id") or "") for p in payouts}

        sendable, blocked, unclear = [], [], []
        for r in rows:
            who = named.get(r.id) or str(r.user_id)
            if r.method == self.name and not r.external_ref:
                unclear.append({"id": r.id, "name": who, "amount": float(r.amount or 0),
                                "reason": "A previous attempt never reported back. "
                                          "Check Stripe for a transfer to this "
                                          "person before sending it again."})
                continue
            u = people.get(r.user_id)
            if u is None or not u.stripe_account_id:
                blocked.append({"id": r.id, "name": who, "amount": float(r.amount or 0),
                                "reason": "Hasn't set up direct deposit yet."})
                continue
            if not u.stripe_payouts_enabled:
                blocked.append({"id": r.id, "name": who, "amount": float(r.amount or 0),
                                "reason": u.stripe_requirements
                                or "Their Stripe setup isn't finished."})
                continue
            sendable.append((r, u, who))

        total_cents = sum(round(float(r.amount or 0) * 100) for r, _, _ in sendable)
        bal = sc.platform_balance()
        if bal is not None and total_cents > bal["available_cents"]:
            # Checked once, up front, rather than discovered on the fourth of
            # eleven transfers. The expected case for TMCC: clients pay through
            # Square and invoices, so the Stripe balance is only ever what was
            # deliberately put there.
            raise PayoutRailUnavailable(
                f"Your Stripe balance is ${bal['available_cents'] / 100:,.2f} and "
                f"this batch is ${total_cents / 100:,.2f}. Nothing was sent — "
                "add funds in Stripe, or send fewer.")

        # THE STAMP. One commit, before any money moves, so a row whose result
        # we never learn is identifiable afterwards. See the class docstring.
        if sendable:
            for r, _, _ in sendable:
                r.method = self.name
                r.updated_at = _now()
            db.commit()

        paid, failed = [], []
        for r, u, who in sendable:
            amount = float(r.amount or 0)
            res = sc.transfer(
                account_id=u.stripe_account_id,
                amount_cents=round(amount * 100),
                idempotency_key=self._key(r),
                description=(r.memo or f"Job #{r.job_id}")[:200],
                metadata={"brightbase_payout_id": str(r.id),
                          "brightbase_job_id": str(r.job_id or ""),
                          "brightbase_earned_on": r.earned_on.isoformat()
                          if r.earned_on else ""},
            )
            if res["ok"]:
                mark(db, org_id, [r.id], "paid", method=self.name,
                     external_ref=res["id"])
                paid.append({"id": r.id, "name": who, "amount": amount,
                             "transfer": res["id"]})
                continue
            if res["definite"]:
                # Stripe answered and refused, so no transfer exists. Take the
                # stamp back off so the row is cleanly retryable once whatever
                # it complained about is fixed.
                r.method = None
                db.commit()
            failed.append({"id": r.id, "name": who, "amount": amount,
                           "reason": res["error"],
                           # False here means "we do not know" — the row stays
                           # stamped and will be refused next time.
                           "certain_nothing_sent": res["definite"]})

        return {
            "rail": self.name,
            "settled": True,
            "count": len(paid),
            "total": round(sum(p["amount"] for p in paid), 2),
            "paid": paid,
            # Everything that did NOT go, each with a reason a person can act
            # on. Returned rather than raised: eight subs getting paid must not
            # be undone by the ninth not having finished onboarding.
            "blocked": blocked,
            "failed": failed,
            "needs_check": unclear,
        }


_RAILS = {ManualRail.name: ManualRail, StripeRail.name: StripeRail}


#: Valid setting values. The router validates against this rather than letting
#: `get_rail` silently fall back, because saving a typo would mean paying by
#: CSV forever while the screen says Stripe.
RAIL_NAMES = tuple(_RAILS)


def available_rails() -> list:
    """What the office can choose between. Names and labels only — asking each
    rail whether it is ready would mean a payments API call per dropdown."""
    return [{"name": cls.name, "label": getattr(cls, "label", cls.name),
             "settles": cls.settles} for cls in _RAILS.values()]


def get_rail(name: Optional[str] = None) -> PayoutRail:
    """The configured rail. Unknown names fall back to manual rather than
    raising — a misconfigured setting should not make it impossible to pay
    anyone."""
    cls = _RAILS.get((name or "").strip().lower() or ManualRail.name)
    if cls is None:
        logger.warning("unknown payout rail %r — falling back to manual", name)
        cls = ManualRail
    return cls()
