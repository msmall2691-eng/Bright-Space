"""Paying subcontractors — the ledger, and the rail that settles it.

This module used to be payroll: hourly rates, the native time clock, weekend
piece rates, mileage, and an export into Square Payroll. All of it is gone
(Sept 2026). The Maine Cleaning Co. does not employ cleaners any more, and a
timecard states an hourly wage and an employment relationship — exactly the
thing a subcontractor arrangement cannot say. Code that can only pay an
employee is code that can only be wrong here.

What is left pays SUBCONTRACTORS: per job, at the rate they agreed, through
services/sub_payouts.py. Nothing in this file reads a punch, and the payout
path never did — a sub's money comes from Job.agreed_rate and the person named
in Job.agreed_cleaner_id (migration 106), not from hours.

THE SCHEMA IS UNTOUCHED. `time_entries` and the User.pay_rate_* columns stay
exactly where they are. Dropping them is a destructive migration for data
nobody can regenerate, and the migration discipline here is additive-only (R8).
Unused columns cost nothing; a dropped table with history in it cannot be
undone. That is a separate decision for when nobody wants the history.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database.db import get_db
from database.models import User
from modules.auth.router import require_role, current_org_id, resolve_org_id
from modules.settings.router import get_setting, set_setting

logger = logging.getLogger(__name__)

router = APIRouter()



# THE EMPLOYEE MACHINERY IS GONE (Sept 2026). Hourly rates, the native time
# clock, mileage and the Square Payroll export lived here and are removed:
# The Maine Cleaning Co. does not employ cleaners any more, and code that
# can only pay an employee is code that can only be wrong. Everything below
# pays SUBCONTRACTORS, per job, at the rate they agreed.
#
# The `time_entries` table and the User.pay_rate_* columns are deliberately
# LEFT IN THE SCHEMA. Dropping them is a destructive migration for data
# nobody can regenerate, and brightbase-migrations is additive-only (R8).
# Unused columns cost nothing; a dropped table with history in it cannot be
# undone. Removing them is a separate decision, made when nobody wants the
# history any more.

def _parse_period(start_date: str, end_date: str):
    try:
        d0 = datetime.strptime(start_date, "%Y-%m-%d").date()
        d1 = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD")
    if d1 < d0:
        raise HTTPException(status_code=422, detail="End date is before start date")
    if (d1 - d0).days > 92:
        raise HTTPException(status_code=422, detail="Pay periods are capped at 92 days")
    return d0, d1


@router.get("/subcontractors", dependencies=[Depends(require_role("admin", "manager"))])
def subcontractor_summary(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Everything the Subcontractors view needs, in ONE request
    (brightbase-economy): what the period earned, what's already on the ledger,
    year-to-date per person, and which rail pays them.

    `earned` is what the period's completed marketplace jobs come to;
    `unrecorded` is the part of that with no payout row yet — the number the
    Generate button acts on. They differ only until Generate is pressed, and
    showing both is what makes pressing it safe."""
    from services import sub_payouts

    d0, d1 = _parse_period(start_date, end_date)
    oid = resolve_org_id(org_id, db)

    plan = sub_payouts.preview(db, oid, d0, d1)
    ledger = sub_payouts.list_payouts(db, oid, start=d0, end=d1)
    ytd = sub_payouts.year_to_date(db, oid)
    rail = sub_payouts.get_rail(get_setting(db, "sub_payout_rail"))

    live = [p for p in ledger if p["status"] in sub_payouts.LIVE_STATUSES]
    return {
        "period": f"{start_date} to {end_date}",
        "start_date": start_date,
        "end_date": end_date,
        "earned_total": round(plan["new_total"]
                              + sum(r["amount"] for r in plan["existing"]), 2),
        "unrecorded": plan["new"],
        "unrecorded_total": plan["new_total"],
        # A crew ID on a marketplace job with no login behind it. Surfaced
        # rather than dropped: it is the one case where work was done and
        # nothing here can say who to pay.
        "unmatched": plan["unmatched"],
        "payouts": ledger,
        "due_total": round(sum(p["amount"] for p in live if p["status"] == "due"), 2),
        "outstanding_total": round(sum(p["amount"] for p in live
                                       if p["status"] != "paid"), 2),
        "paid_total": round(sum(p["amount"] for p in live
                                if p["status"] == "paid"), 2),
        "ytd": ytd,
        "rail": {"name": rail.name, "settles": rail.settles},
    }


class GeneratePayoutsBody(BaseModel):
    start_date: str
    end_date: str


@router.post("/subcontractors/payouts/generate",
             dependencies=[Depends(require_role("admin"))])
def generate_payouts(body: GeneratePayoutsBody, db: Session = Depends(get_db),
                     org_id: int = Depends(current_org_id)):
    """Record what the period's completed marketplace work owes.

    Creates `due` rows only — no money moves here. Idempotent: running it twice
    on the same period creates nothing the second time."""
    from services import sub_payouts

    d0, d1 = _parse_period(body.start_date, body.end_date)
    return sub_payouts.generate(db, resolve_org_id(org_id, db), d0, d1)


class MarkPayoutsBody(BaseModel):
    payout_ids: list
    status: str
    method: Optional[str] = None
    external_ref: Optional[str] = None


@router.post("/subcontractors/payouts/mark",
             dependencies=[Depends(require_role("admin"))])
def mark_payouts(body: MarkPayoutsBody, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id)):
    """Move payouts along: due → sent → paid, or void.

    Marking `paid` is a human asserting money left. Nothing else in the system
    sets it, because nothing else knows."""
    from services import sub_payouts

    if not body.payout_ids:
        raise HTTPException(status_code=422, detail="Nothing selected")
    try:
        return sub_payouts.mark(db, resolve_org_id(org_id, db), body.payout_ids,
                                body.status, method=body.method,
                                external_ref=body.external_ref)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class SendPayoutsBody(BaseModel):
    payout_ids: list


@router.post("/subcontractors/payouts/send",
             dependencies=[Depends(require_role("admin"))])
def send_payouts(body: SendPayoutsBody, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id)):
    """Hand the selected payouts to the configured rail.

    The manual rail returns a CSV and marks them `sent` — it cannot know
    whether a cheque was written, so `paid` stays a separate human act. Only
    `due` payouts are sendable; re-sending something already out is how one
    person gets paid twice."""
    from services import sub_payouts

    oid = resolve_org_id(org_id, db)
    rows = [p for p in sub_payouts.list_payouts(db, oid, status="due")
            if p["id"] in set(body.payout_ids or [])]
    if not rows:
        raise HTTPException(status_code=422,
                            detail="Nothing to send — those payouts aren't due.")
    rail = sub_payouts.get_rail(get_setting(db, "sub_payout_rail"))
    return rail.send(db, oid, rows)


# ── Stripe Connect webhook (migration 108) ──────────────────────────────────


@router.post("/stripe/webhook")  # PUBLIC: Stripe posts here; the signature is verified inside
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    """Keep the cached payout state true.

    The ONLY writer of `stripe_payouts_enabled` / `stripe_requirements`. Every
    other surface reads the cache, which is what keeps a crew screen render
    free of a Stripe API call (brightbase-economy) and keeps this off a polling
    tick (scheduling-invariants R1).

    SIGNATURE FIRST, and refuse rather than trust when we cannot check. This
    endpoint is public — it has to be, Stripe cannot send our API key — so the
    signature is the only thing standing between a stranger and marking any
    sub's payouts enabled. Same posture as the Twilio webhook (BB-SEC-06): no
    secret configured means reject, not accept.

    Always 200 on a well-formed, verified event, even one we ignore. Stripe
    retries non-2xx for days, and retrying an event we deliberately do not
    handle is noise for both sides.
    """
    from integrations.stripe_connect import summarize, webhook_secret

    secret = webhook_secret()
    if not secret:
        logger.error("[stripe] rejecting webhook — STRIPE_WEBHOOK_SECRET not set, "
                     "cannot verify the signature")
        raise HTTPException(status_code=503, detail="Webhook not configured.")

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        import stripe
        event = stripe.Webhook.construct_event(payload, sig, secret)
    except Exception:
        logger.warning("[stripe] rejected webhook with a bad signature")
        raise HTTPException(status_code=400, detail="Bad signature.")

    kind = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}

    if kind == "account.updated":
        acct_id = obj.get("id")
        u = (db.query(User).filter(User.stripe_account_id == acct_id).first()
             if acct_id else None)
        if u is None:
            # An account we do not know about. Not an error — the same Stripe
            # account can serve more than one thing — but worth a line so a
            # genuine mismatch is findable.
            logger.info("[stripe] account.updated for an unknown account %s", acct_id)
            return {"ok": True, "ignored": True}
        state = summarize(obj)
        was = bool(u.stripe_payouts_enabled)
        u.stripe_payouts_enabled = state["payouts_enabled"]
        u.stripe_requirements = state["requirements"]
        u.stripe_synced_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
        if state["payouts_enabled"] and not was:
            # Worth telling them: the setup they started is finished, and the
            # next payout goes to their bank rather than onto a cheque list.
            try:
                from services.push_service import notify_user
                notify_user(u.id, "Direct deposit is on",
                            "Your details are verified — the next payout goes "
                            "straight to your bank.",
                            url="/my-day", category="job_assignments")
            except Exception:
                logger.warning("[stripe] payouts-enabled notification failed", exc_info=True)
        return {"ok": True, "payouts_enabled": state["payouts_enabled"]}

    return {"ok": True, "ignored": True}
