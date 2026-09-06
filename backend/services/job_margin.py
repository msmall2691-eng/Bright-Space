"""What a job bills, what it pays out, and what's left.

The routes plan put it plainly: post a job without seeing its margin and the
margin is what you'll lose. Everything the marketplace pivot added sets a
price — a posted rate on a one-off, a block rate on a route, a ladder on a
Saturday window — and until now every one of those was typed into a box with
no other number beside it.

THE HARD PART IS NOT THE ARITHMETIC. It's that a job's billed amount lives in
four different places depending on how far along it is, and the four are not
equally trustworthy. A margin computed from a guess, shown with the same
confidence as one computed from an invoice, is worse than no margin: it is a
number somebody will price the next ten jobs against.

So this returns the SOURCE alongside the amount, every time, and the UI says
which one it used. In descending order of how much you should believe it:

  invoice   the invoice raised for this job. What was actually charged.
  quote     the accepted quote this job came from. What was agreed.
  history   the average of recent invoiced visits at the same property. What
            this house usually bills.
  none      nothing to go on. Reported as None, never as zero — "we bill
            nothing for this" and "we don't know" are different answers, and
            only one of them implies a 100% margin.

A draft invoice does NOT count. A draft is a piece of paper; it can be edited
or deleted and has never been sent to anybody.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Invoice, Job, Quote
from utils.dates import business_today

logger = logging.getLogger(__name__)

# How far back the history fallback looks, and how many visits it averages.
# A season, roughly: pricing changes, and a number from eighteen months ago is
# not what this house bills now.
HISTORY_DAYS = 180
HISTORY_VISITS = 4

SOURCE_LABELS = {
    "invoice": "this job's invoice",
    "quote": "the accepted quote",
    "history": "what this house usually bills",
    "none": None,
}


def _scope(model, org_id: int):
    return or_(model.org_id == org_id, model.org_id.is_(None))


def billed_amount(db: Session, job, org_id: int) -> dict:
    """What this job bills, and how much to believe it.

    Returns {amount, source, detail}. `amount` is None when there is nothing to
    go on — never 0.0, because zero is a claim and this isn't one.
    """
    inv = (db.query(Invoice)
           .filter(Invoice.job_id == job.id,
                   Invoice.status != "draft",
                   _scope(Invoice, org_id))
           .order_by(Invoice.id.desc())
           .first())
    if inv is not None and inv.total:
        return {"amount": round(float(inv.total), 2), "source": "invoice", "detail": None}

    quote_id = getattr(job, "quote_id", None)
    if quote_id:
        q = (db.query(Quote)
             .filter(Quote.id == quote_id, _scope(Quote, org_id))
             .first())
        if q is not None and q.total:
            return {"amount": round(float(q.total), 2), "source": "quote", "detail": None}

    # Nothing on this job itself. What does this house usually bill?
    if job.property_id:
        since = business_today() - timedelta(days=HISTORY_DAYS)
        rows = (db.query(Invoice.total)
                .join(Job, Job.id == Invoice.job_id)
                .filter(Job.property_id == job.property_id,
                        Job.id != job.id,
                        Job.scheduled_date >= since,
                        Job.status == "completed",
                        Invoice.status != "draft",
                        _scope(Invoice, org_id))
                .order_by(Job.scheduled_date.desc())
                .limit(HISTORY_VISITS)
                .all())
        totals = [float(t[0]) for t in rows if t[0]]
        if totals:
            return {"amount": round(sum(totals) / len(totals), 2), "source": "history",
                    "detail": {"visits": len(totals)}}

    return {"amount": None, "source": "none", "detail": None}


def margin(db: Session, job, org_id: int, *, pay: Optional[float] = None) -> dict:
    """Billed, paid out, and what's left — for one job.

    `pay` overrides what the job says it pays, so the office can ask "what
    would the margin be if I posted this at $120" without writing $120 down
    first. That question is the whole reason this exists: the number is only
    useful BEFORE the price is set.

    Defaults to agreed_rate when there is one (that's real money now) and
    posted_rate otherwise (that's the offer on the table).
    """
    billed = billed_amount(db, job, org_id)
    if pay is None:
        pay = job.agreed_rate if job.agreed_rate is not None else job.posted_rate
    pay = float(pay) if pay is not None else None

    out = {
        "billed": billed["amount"],
        "billed_source": billed["source"],
        "billed_detail": billed["detail"],
        "pay": pay,
        "margin": None,
        "margin_pct": None,
    }
    if billed["amount"] is None or pay is None:
        return out

    out["margin"] = round(billed["amount"] - pay, 2)
    if billed["amount"]:
        out["margin_pct"] = round(out["margin"] / billed["amount"] * 100, 1)
    return out


def window_margin(db: Session, window, org_id: int) -> dict:
    """What a turnover window's price ladder does to the margin — including at
    the top of it.

    The ceiling is the number to look at. A ladder set once in March quietly
    becomes the thing that eats a July Saturday, and the office would find out
    from the payroll run rather than from the box they typed it into.

    Only the UNTAKEN jobs are priced against the ladder: the ones already
    claimed are at their agreed rate and aren't going anywhere.
    """
    from services.turnover_windows import _is_taken, current_rate, window_jobs

    jobs = window_jobs(db, window)
    open_jobs = [j for j in jobs if not _is_taken(j)]
    now_rate = current_rate(window)
    ceiling_rate = None
    if window.base_rate is not None:
        ceiling_rate = round(float(window.base_rate)
                             * (1 + (float(window.step_pct or 0) / 100.0)
                                * int(window.max_steps or 0)), 2)

    billed_total, known = 0.0, 0
    for j in open_jobs:
        b = billed_amount(db, j, org_id)
        if b["amount"] is not None:
            billed_total += b["amount"]
            known += 1

    out = {
        "open_jobs": len(open_jobs),
        "billed_known_for": known,
        "billed": round(billed_total, 2) if known else None,
        "pay_now": round(now_rate * len(open_jobs), 2) if now_rate is not None else None,
        "pay_at_ceiling": (round(ceiling_rate * len(open_jobs), 2)
                           if ceiling_rate is not None else None),
        "margin_now": None,
        "margin_at_ceiling": None,
        # True when the whole ladder is affordable. False is the interesting
        # answer and the one the screen should say out loud.
        "ceiling_fits": None,
    }
    if known and known == len(open_jobs) and out["pay_now"] is not None:
        out["margin_now"] = round(billed_total - out["pay_now"], 2)
        if out["pay_at_ceiling"] is not None:
            out["margin_at_ceiling"] = round(billed_total - out["pay_at_ceiling"], 2)
            out["ceiling_fits"] = out["margin_at_ceiling"] >= 0
    return out
