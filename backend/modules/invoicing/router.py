import logging
import os
import secrets
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, func
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Optional, List, Literal
from datetime import datetime, date, timezone

from utils.dates import business_tz, business_today, coerce_date

from database.db import get_db
from database.models import Invoice, Client, Message
from modules.auth.router import require_role, current_org_id, resolve_org_id
from utils.activity_logger import log_invoice_created, log_invoice_paid
from ratelimit import rate_limit


logger = logging.getLogger(__name__)

router = APIRouter()


class InvoiceItem(BaseModel):
    name: str
    description: Optional[str] = ""
    qty: float = 1
    unit_price: float


class InvoiceCreate(BaseModel):
    client_id: int
    job_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    items: List[InvoiceItem]
    tax_rate: Optional[float] = 0
    # BB-INV-01: flat $ off, after tax. ge=0 — total = subtotal + tax - discount,
    # so a NEGATIVE discount silently ADDS to the total (a hidden surcharge the
    # customer never agreed to). A discount only ever subtracts; reject below zero.
    discount: Optional[float] = Field(default=0, ge=0)
    due_date: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = {}


class InvoiceUpdate(BaseModel):
    items: Optional[List[InvoiceItem]] = None
    tax_rate: Optional[float] = None
    discount: Optional[float] = Field(default=None, ge=0)  # BB-INV-01: never negative (see InvoiceCreate)
    status: Optional[Literal["draft", "sent", "paid", "overdue", "void"]] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None
    paid_at: Optional[str] = None
    custom_fields: Optional[dict] = None


def assign_invoice_number(db: Session, inv: Invoice) -> str:
    """Assign a race-free invoice number derived from the row's own primary key.

    The old `max(Invoice.id)+1` raced two concurrent creates onto the same
    number (unique-violation 500) and was a single global counter. The PK is
    unique and monotonic, so deriving from it is collision-free — the same
    approach the quote numbering already uses. Idempotent (never overwrites an
    existing number); flushes to materialize the PK when needed.

    Every path that creates an invoice MUST call this. An unnumbered invoice
    mails the customer an email/SMS titled "Invoice None" (the auto-invoice on
    job completion skipped it — see modules/scheduling/router.py)."""
    if inv.invoice_number:
        return inv.invoice_number
    if inv.id is None:
        db.flush()
    inv.invoice_number = f"INV-{str(inv.id).zfill(4)}"
    return inv.invoice_number


def calc_totals(items: list, tax_rate: float, discount: float = 0.0) -> tuple:
    # BB-INV-01: tax is charged on the full subtotal; the discount is a flat
    # dollar amount taken off AFTER tax — identical to the quote's
    # `_compute_totals` (modules/quoting/router.py), so a quote and the invoice
    # raised from it agree to the cent.
    subtotal = sum(i["qty"] * i["unit_price"] for i in items)
    tax = round(subtotal * (tax_rate / 100), 2)
    total = round(subtotal + tax - float(discount or 0), 2)
    return round(subtotal, 2), tax, total


def _ensure_invoice_public_token(inv: Invoice) -> str:
    """Return the invoice's public (no-login) page token, minting one if missing.

    Same shape as _ensure_job_public_token / the quote token: an unguessable
    URL-safe token that IS the credential for /pay/{token}. Caller commits."""
    if not inv.public_token:
        inv.public_token = secrets.token_urlsafe(32)
    return inv.public_token


def invoice_to_dict(inv: Invoice) -> dict:
    return {
        "id": inv.id,
        "client_id": inv.client_id,
        "job_id": inv.job_id,
        "opportunity_id": inv.opportunity_id,
        "invoice_number": inv.invoice_number,
        # Office-only: lets InvoiceDetail show/copy the customer's pay-page link.
        # None until the invoice has been sent at least once.
        "public_token": inv.public_token,
        "items": inv.items,
        "subtotal": inv.subtotal,
        "tax_rate": inv.tax_rate,
        "tax": inv.tax,
        "discount": inv.discount or 0,
        "total": inv.total,
        "status": inv.status,
        "due_date": inv.due_date,
        "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
        "notes": inv.notes,
        "custom_fields": inv.custom_fields or {},
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
        "updated_at": inv.updated_at.isoformat() if inv.updated_at else None,
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_invoices(
    client_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    # MT-2: scope to the caller's workspace; tolerate legacy NULL-org rows.
    q = db.query(Invoice).filter(or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)))
    if client_id:
        q = q.filter(Invoice.client_id == client_id)
    if status:
        q = q.filter(Invoice.status == status)
    return [invoice_to_dict(i) for i in q.order_by(Invoice.created_at.desc()).offset(offset).limit(limit).all()]


@router.get("/summary", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def invoice_summary(
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Accurate money headline across ALL of the org's invoices — independent of
    the list endpoint's page (default 50) and status filter, so the KPI tiles and
    AR aging never mislead. One aggregate query for the per-status totals + a
    second over just the unpaid rows for the aging buckets (brightbase-economy:
    this is the screen's one 'headline' need, distinct from the paginated list).
    'outstanding' and the aging match the board's definition (sent + overdue)."""
    scope = or_(Invoice.org_id == org_id, Invoice.org_id.is_(None))
    rows = (
        db.query(Invoice.status, func.coalesce(func.sum(Invoice.total), 0.0), func.count())
        .filter(scope)
        .group_by(Invoice.status)
        .all()
    )
    by_status = {s: (float(tot or 0.0), int(cnt)) for s, tot, cnt in rows}
    collected = by_status.get("paid", (0.0, 0))[0]
    sent_tot = by_status.get("sent", (0.0, 0))[0]
    overdue_tot, overdue_cnt = by_status.get("overdue", (0.0, 0))

    # Aging: split the outstanding (sent + overdue) balance by days past due.
    # due_date is a stored string, so bucket in Python over just the unpaid rows.
    today = business_today()
    aging = {"current": 0.0, "d1_30": 0.0, "d31_60": 0.0, "d60_plus": 0.0}
    unpaid = (
        db.query(Invoice.total, Invoice.due_date)
        .filter(scope, Invoice.status.in_(("sent", "overdue")))
        .all()
    )
    for total, due in unpaid:
        amt = float(total or 0.0)
        dd = coerce_date(due)
        days = (today - dd).days if dd else 0
        if days <= 0:
            aging["current"] += amt
        elif days <= 30:
            aging["d1_30"] += amt
        elif days <= 60:
            aging["d31_60"] += amt
        else:
            aging["d60_plus"] += amt

    return {
        "collected": round(collected, 2),
        "outstanding": round(sent_tot + overdue_tot, 2),
        "overdue_total": round(overdue_tot, 2),
        "overdue_count": overdue_cnt,
        "aging": {k: round(v, 2) for k, v in aging.items()},
    }


def _business_month_start_utc() -> datetime:
    """00:00 on the 1st of the current month IN MAINE, as naive UTC.

    `paid_at` is stored as naive UTC, and this was
    `datetime.now().replace(day=1, …)` — the server's clock, which in the
    container is UTC. So the month began at 00:00 UTC, which is 8pm on the LAST
    day of the previous month in Maine, and every invoice paid in that evening
    window landed in the wrong month: the month just ended lost revenue it had
    earned, the new one gained revenue it had not. Four or five hours of wrong
    numbers at every month boundary, on the figure the owner checks first.

    Built the other way round now: take the business-local month start, then
    convert to UTC to compare against what is stored.
    """
    tz = business_tz()
    local_first = datetime.now(tz).replace(day=1, hour=0, minute=0, second=0,
                                           microsecond=0)
    return local_first.astimezone(timezone.utc).replace(tzinfo=None)


@router.get("/summary/by-service", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def invoice_summary_by_service(
    period: str = Query("mtd", pattern="^(mtd|all)$"),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Paid-revenue split by service type (residential/commercial/str_turnover),
    joined through the invoice's job. `period=mtd` (default) limits to this month
    by paid_at; `all` is all-time. Powers the dashboard's revenue breakdown.

    ORG-SCOPED, and it was not: role-gated but with no tenant filter, so the
    totals summed every workspace's paid invoices together. Latent with one
    org and a wrong number with two — and revenue is the last figure anybody
    would think to doubt.
    """
    from sqlalchemy import func
    from database.models import Job

    oid = resolve_org_id(org_id, db)
    q = (
        db.query(Job.job_type, func.count(Invoice.id), func.coalesce(func.sum(Invoice.total), 0.0))
        .join(Invoice, Invoice.job_id == Job.id)
        .filter(Invoice.status == "paid",
                or_(Invoice.org_id == oid, Invoice.org_id.is_(None)))
    )
    if period == "mtd":
        q = q.filter(Invoice.paid_at >= _business_month_start_utc())
    rows = q.group_by(Job.job_type).all()
    return {
        "period": period,
        "by_service": [
            {"service": (jt or "residential"), "count": int(c or 0), "total": float(tot or 0)}
            for jt, c, tot in rows
        ],
    }


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_invoice(data: InvoiceCreate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    items = [i.model_dump() for i in data.items]
    discount = float(data.discount or 0)
    subtotal, tax, total = calc_totals(items, data.tax_rate or 0, discount)
    inv = Invoice(
        client_id=data.client_id,
        job_id=data.job_id,
        opportunity_id=data.opportunity_id,
        org_id=resolve_org_id(org_id, db),  # MT-2: stamp the caller's workspace
        items=items,
        subtotal=subtotal,
        tax_rate=data.tax_rate or 0,
        tax=tax,
        discount=discount,
        total=total,
        due_date=data.due_date,
        notes=data.notes,
        custom_fields=data.custom_fields or {},
    )
    db.add(inv)
    db.flush()                      # materialize the PK
    assign_invoice_number(db, inv)  # race-free number derived from it
    db.commit()
    db.refresh(inv)
    # Timeline: record the invoice being raised (best-effort — never block the
    # create on a logging hiccup).
    try:
        log_invoice_created(db, inv)
        db.commit()
    except Exception:
        db.rollback()
    return invoice_to_dict(inv)


@router.get("/{invoice_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_invoice(invoice_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice_to_dict(inv)


@router.get("/{invoice_id}/details", dependencies=[Depends(require_role("admin", "manager"))])
def get_invoice_details(invoice_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Full invoice record for the detail page: the invoice (incl. line items)
    plus its linked records — client, job, opportunity, and the originating
    quote (reached via Job.quote_id when the invoice came from a job)."""
    from database.models import Job, Opportunity, Quote
    oid = resolve_org_id(org_id, db)
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == oid, Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    client = db.query(Client).filter(Client.id == inv.client_id).first()
    job = db.query(Job).filter(Job.id == inv.job_id).first() if inv.job_id else None
    opp = db.query(Opportunity).filter(Opportunity.id == inv.opportunity_id).first() if inv.opportunity_id else None
    quote = db.query(Quote).filter(Quote.id == job.quote_id).first() if (job and job.quote_id) else None

    return {
        **invoice_to_dict(inv),
        "client_name": client.name if client else None,
        "job": ({"id": job.id, "title": job.title, "status": job.status,
                 "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None} if job else None),
        "opportunity": ({"id": opp.id, "title": opp.title, "stage": opp.stage} if opp else None),
        "quote": ({"id": quote.id, "quote_number": quote.quote_number, "total": quote.total} if quote else None),
    }


@router.patch("/{invoice_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_invoice(invoice_id: int, data: InvoiceUpdate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    was_paid = inv.status == "paid"
    # BB-INV-01: any of items / tax_rate / discount changing reprices the
    # invoice. It used to recompute only when `items` was supplied, so editing
    # just the tax rate or the discount left `total` stale — the number the
    # customer is billed diverging from the line items on the same invoice.
    if any(v is not None for v in (data.items, data.tax_rate, data.discount)):
        items = [i.model_dump() for i in data.items] if data.items is not None else (inv.items or [])
        tax_rate = data.tax_rate if data.tax_rate is not None else inv.tax_rate
        discount = data.discount if data.discount is not None else (inv.discount or 0)
        subtotal, tax, total = calc_totals(items, tax_rate or 0, discount)
        old_total = inv.total
        inv.items = items
        inv.subtotal = subtotal
        inv.tax = tax
        inv.discount = discount
        inv.total = total
        # REPRICING KILLS THE PAYMENT LINK. A Stripe Checkout session is
        # created for the total at the moment it was opened and cannot be
        # amended; leaving it live after the price changes means the customer
        # can still pay the OLD amount against the NEW invoice. Dropping the
        # stored session means the next tap mints one for the real total, and
        # the webhook's amount check (see `record_checkout_payment`) catches a
        # session that was already in flight when this edit landed.
        #
        # Only when the number actually moved: a no-op edit should not
        # invalidate a link the customer may have open.
        if total != old_total:
            inv.stripe_checkout_session_id = None
            inv.stripe_checkout_expires_at = None
    for field in ["tax_rate", "status", "due_date", "notes", "custom_fields"]:
        val = getattr(data, field)
        if val is not None:
            setattr(inv, field, val)
    if data.paid_at:
        inv.paid_at = datetime.fromisoformat(data.paid_at)
        inv.status = "paid"
    # BB-INV-03: a status→paid edit must stamp the payment date even when the
    # caller sent no paid_at (the "Mark paid" button does exactly this — it
    # PATCHes status only). Revenue-by-month filters on paid_at, so a paid
    # invoice with paid_at NULL reads as collected on the invoice yet never
    # lands in ANY month's revenue — money that vanishes from the figure the
    # owner checks first. Only fill an unset date; never move one the caller
    # gave or the invoice already carried.
    if inv.status == "paid" and inv.paid_at is None:
        inv.paid_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(inv)
    # Timeline: log the paid transition once (whether it came via paid_at or a
    # status="paid" edit), never on an already-paid invoice.
    if inv.status == "paid" and not was_paid:
        try:
            log_invoice_paid(db, inv)
            db.commit()
        except Exception:
            db.rollback()
    return invoice_to_dict(inv)


@router.delete("/{invoice_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_invoice(invoice_id: int, force: bool = False,
                   db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """BB-SEC-10: deleting a PAID invoice erases the payment record — the
    money trail for work already done. It used to be a plain delete with no
    server-side distinction; a paid invoice now 409s unless the caller
    explicitly passes ?force=true (the UI escalates its confirm and retries
    with force). Unpaid invoices delete as before."""
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if not force and (inv.status or "").lower() == "paid":
        raise HTTPException(status_code=409, detail={
            "code": "invoice_paid",
            "message": "This invoice is PAID — deleting it erases the payment record.",
        })
    db.delete(inv)
    db.commit()


class SendInvoiceRequest(BaseModel):
    channel: Literal["email", "sms", "both"]
    email: Optional[str] = None
    phone: Optional[str] = None
    custom_message: Optional[str] = None


@router.post("/{invoice_id}/send", dependencies=[Depends(require_role("admin", "manager"))])
def send_invoice(invoice_id: int, data: SendInvoiceRequest, db: Session = Depends(get_db)):
    """Send an invoice to a client via email and/or SMS."""
    from integrations.email import send_email, build_invoice_email, build_invoice_sms
    from services.sms_send import send_and_log

    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    client = db.query(Client).filter(Client.id == inv.client_id).first()
    client_name = client.name if client else f"Client #{inv.client_id}"
    # Heal invoices auto-created without a number (older completions) so the
    # customer never receives an email/SMS titled "Invoice None". The set value
    # persists on the db.commit() at the end of this handler.
    inv_num = assign_invoice_number(db, inv)
    # Mint the public pay-page token now, so a sent invoice always has a stable
    # /pay/{token} link (persisted on the db.commit() at the end of this handler).
    _ensure_invoice_public_token(inv)
    inv_dict = invoice_to_dict(inv)
    company_phone = os.getenv("TWILIO_PHONE_NUMBER", "")
    results = {}

    if data.channel in ("email", "both"):
        to_email = data.email or (client.email if client else None)
        if not to_email:
            raise HTTPException(status_code=400, detail="No email address available")
        html, plain = build_invoice_email(inv_dict, client_name, company_phone)
        # A custom note (e.g. an AI-drafted payment reminder) is prepended to
        # both the HTML and plain-text bodies, mirroring the SMS path below.
        if data.custom_message:
            from html import escape as _esc
            note_html = "".join(
                f"<p style=\"margin:0 0 12px\">{_esc(line)}</p>"
                for line in data.custom_message.split("\n") if line.strip()
            )
            html = note_html + html
            plain = data.custom_message + "\n\n" + plain
        try:
            send_email(to=to_email, subject=f"Invoice {inv_num} — Maine Cleaning Co", html_body=html, text_body=plain)
            results["email"] = "sent"
            msg = Message(client_id=inv.client_id, channel="email", direction="outbound",
                          from_addr=os.getenv("SMTP_USER", ""), to_addr=to_email,
                          body=f"Invoice {inv_num} sent via email", status="sent",
                          org_id=inv.org_id)  # BB-MT-01
            db.add(msg)
        except Exception as e:
            results["email"] = f"failed: {str(e)}"

    if data.channel in ("sms", "both"):
        to_phone = data.phone or (client.phone if client else None)
        if not to_phone:
            raise HTTPException(status_code=400, detail="No phone number available")
        sms_body = build_invoice_sms(inv_dict, client_name, company_phone)
        if data.custom_message:
            sms_body = data.custom_message + "\n\n" + sms_body
        try:
            send_and_log(to=to_phone, body=sms_body, action="invoice",
                         entity_type="invoice", entity_id=inv.id,
                         org_id=getattr(inv, "org_id", None))
            results["sms"] = "sent"
            msg = Message(client_id=inv.client_id, channel="sms", direction="outbound",
                          from_addr=company_phone, to_addr=to_phone, body=sms_body, status="sent",
                          org_id=inv.org_id)  # BB-MT-01
            db.add(msg)
        except Exception as e:
            results["sms"] = f"failed: {str(e)}"

    # Mark as sent if it was draft
    if inv.status == "draft":
        inv.status = "sent"
    db.commit()

    return {"invoice_id": invoice_id, "results": results}


# ── Public (no-login) invoice page ───────────────────────────────────────────
#
# History: an earlier `GET /public/{invoice_id}/{token}` was deleted because it
# (a) never worked end-to-end and (b) leaked the customer's email and phone to
# any token holder. The owner has since re-authorized a customer-facing invoice
# page (online payment), so it is rebuilt here — deliberately fixing both
# faults: the read side is verified end-to-end (see tests/test_public_invoice.py)
# and the payload is MINIMAL — invoice number, line items, money, due date,
# status, and the company name for "questions". NO email, phone, address,
# internal notes, custom_fields, or any other invoice. The token is a stored,
# per-row credential (revocable one invoice at a time by nulling the column).
#
# Taking money IS now here: `start_checkout` opens a hosted Stripe Checkout
# session and a signature-verified webhook flips the invoice to paid. It is
# STRIPE and not Square because the charge credits TMCC's own Stripe balance —
# the same balance services/sub_payouts.StripeRail spends from when it pays the
# bench, which previously started at zero and had to be funded by hand. See
# integrations/stripe_payments.py for that reasoning in full.
#
# With no STRIPE_SECRET_KEY the page degrades to the old read-only "call/text
# us" seam rather than a dead button — an integration nobody has finished
# configuring must not present as a button the customer commits to and then
# watches fail.

def _online_payment_enabled() -> bool:
    """Whether the public page should offer to take money.

    Needs the webhook secret as well as the API key: without it the payment
    succeeds at Stripe and the invoice is never marked paid. See
    `stripe_payments.can_take_payments`.
    """
    from integrations.stripe_payments import can_take_payments
    return can_take_payments()


def _amount_due(inv: Invoice) -> float:
    """What is still owed on this invoice.

    There are no partial payments in this schema — an invoice is open for its
    full total or it is settled — so this is `total`, or zero once it is paid
    or void. It is a named function rather than an inline `inv.total` so the
    checkout path and the office path share ONE answer to "how much", and so
    part-payment, if it is ever added, has one place to land.
    """
    if (inv.status or "") in ("paid", "void"):
        return 0.0
    return round(float(inv.total or 0), 2)


def _record_payment(db: Session, inv: Invoice, *, from_addr: str = "",
                    to_addr: str = "", body: Optional[str] = None,
                    payment_intent_id: Optional[str] = None) -> dict:
    """THE one place an invoice becomes paid. Idempotent.

    Both ways money arrives funnel through here — the office writing down a
    cheque (`process_payment`) and Stripe confirming a card or bank debit
    (`record_checkout_payment`) — for the same reason
    `services/claim_approval.py` is the single approve implementation: two
    copies of "mark it paid" drift, and the half that drifts is the half that
    writes the revenue figure.

    BB-INV-03 lives here now. Recording a payment on an already-paid invoice
    used to overwrite `paid_at` with a fresh now() — moving the real payment
    date, so a cheque banked last month jumped into this month's revenue — and
    wrote a SECOND "payment received" message, double-recording money that came
    in once. A double-click did both; so does a webhook Stripe retries, which
    it will. Recording a payment twice must change nothing.
    """
    already = (inv.status or "") == "paid"

    # Fill the Stripe reference if we learned it, never replace one already
    # recorded. An invoice paid by hand and later matched to a Stripe payment
    # is worth stamping; a retry is not worth relabelling.
    if payment_intent_id and not inv.stripe_payment_intent_id:
        inv.stripe_payment_intent_id = payment_intent_id

    if already:
        # Heal a legacy paid row that never got a date, and NEVER move a date
        # that is already there — that is the BB-INV-03 bug (a cheque banked
        # last month jumping into this month's revenue).
        if inv.paid_at is None:
            inv.paid_at = datetime.now(timezone.utc)
        db.commit()
        return {"status": "success", "message": "Invoice already recorded as paid",
                "invoice_id": inv.id, "already_paid": True}

    inv.status = "paid"
    # A GENUINE transition stamps now, unconditionally. An invoice that was
    # paid, reopened to `sent`, and is being paid again carries a stale
    # `paid_at`; the date of the payment being recorded is today's, not the old
    # one. (Only setting this when it was NULL quietly backdated that case.)
    inv.paid_at = datetime.now(timezone.utc)

    # Create a payment message record
    msg = Message(
        client_id=inv.client_id,
        channel="payment",
        direction="inbound",
        from_addr=from_addr,
        to_addr=to_addr,
        body=body or f"Payment received: ${inv.total}",
        status="received",
        org_id=inv.org_id,  # BB-MT-01
    )
    db.add(msg)
    # Timeline: log the paid transition alongside the payment message. The
    # already-paid case returned above, so this is always the first time.
    log_invoice_paid(db, inv)
    db.commit()

    return {"status": "success",
            "message": f"Payment of ${inv.total} received and recorded",
            "invoice_id": inv.id}


def _public_invoice_dict(inv: Invoice, db: Session) -> dict:
    """The MINIMAL customer-facing shape for /pay/{token}. Deliberately omits
    all contact PII and every internal field — see the note above."""
    client = db.query(Client).filter(Client.id == inv.client_id).first()
    company_name = os.getenv("FROM_NAME", "Maine Cleaning Co")
    company_phone = os.getenv("TWILIO_PHONE_NUMBER", "")
    return {
        "invoice_number": inv.invoice_number,
        # Display name only — confirms the customer has the right invoice. No
        # email / phone / address (that leak is why the old endpoint was killed).
        "client_name": (client.name if client else None),
        "items": inv.items or [],
        "subtotal": inv.subtotal,
        "tax_rate": inv.tax_rate,
        "tax": inv.tax,
        "discount": inv.discount or 0,
        "total": inv.total,
        "status": inv.status,        # sent | overdue | paid | void
        "due_date": inv.due_date,
        "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
        "notes": inv.notes,          # customer-facing invoice note (shown on the email too)
        "company_name": company_name,
        "company_phone": company_phone,
        # Whether to show a pay button or the "call/text us" fallback. False
        # when Stripe isn't configured, so an unfinished integration reads as
        # "not available" rather than as a button that fails after the customer
        # has decided to pay.
        "online_payment_enabled": _online_payment_enabled(),
    }


@router.get("/public/{token}", dependencies=[Depends(rate_limit(120, 3600, "invoice_view"))])
def public_view_invoice(token: str, db: Session = Depends(get_db)):
    """Customer-facing view of a single invoice via its public token. No login;
    the unguessable token in the path is the credential. Minimal payload."""
    inv = db.query(Invoice).filter(Invoice.public_token == token).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return _public_invoice_dict(inv, db)


@router.post("/{invoice_id}/pay", dependencies=[Depends(require_role("admin", "manager"))])
def process_payment(invoice_id: int, data: dict, db: Session = Depends(get_db)):
    """Record a payment the office has ALREADY RECEIVED. Admin/manager only.

    This does not take money and never did — there is no card capture, no
    payment intent and no webhook anywhere in this app. It is the office
    writing down that a cheque cleared or a card went through a terminal.

    The previous docstring's "in production, Stripe webhooks should confirm
    payment server-side" described a flow that was never built and has now
    been deliberately declined: the dead public payment page and its token
    were deleted rather than finished. So the honest reading of a POST here is
    "I got paid", not "pay me" — which is why it stays gated to admin/manager.
    """
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # BB-INV-03 (idempotency) now lives in _record_payment, shared with the
    # Stripe webhook so both paths cannot disagree about what "paid" does.
    return _record_payment(db, inv,
                           from_addr=data.get("email", "") or "",
                           to_addr=data.get("phone", "") or "")


# ── Online payment: hosted Stripe Checkout ───────────────────────────────────
#
# The write side of the public page. Two pieces, and the split is the point:
# the browser can only ever OPEN a payment, and only a signature-verified
# webhook can mark one paid. Nothing a customer can send to this app decides
# that an invoice is settled.


def _checkout_urls(token: str) -> tuple:
    """Where Stripe sends the customer back to. Both land on the invoice's own
    public page, which re-reads status from the server — so the "paid" the
    customer sees after returning is the invoice's real state, not a claim
    carried in the URL."""
    from config import app_base_url
    base = app_base_url().rstrip("/")
    return (f"{base}/pay/{token}?paid=1", f"{base}/pay/{token}?cancelled=1")


@router.post("/public/{token}/checkout",
             dependencies=[Depends(rate_limit(20, 3600, "invoice_checkout"))])
def start_checkout(token: str, db: Session = Depends(get_db)):
    """Open (or re-open) the hosted payment page for one invoice.

    PUBLIC: the unguessable token in the path is the credential, same as the
    read endpoint above. It is a POST that reaches Stripe, so it is metered —
    without a limit the token doubles as a free Stripe-session generator.

    ONE LIVE SESSION PER INVOICE. Two tabs on the same invoice must not become
    two payments, so an existing open session is handed back rather than a
    second one minted. The cached `stripe_checkout_expires_at` is a fast
    negative check — once it has passed, go straight to creating a new session
    instead of asking Stripe about a session we know is dead
    (brightbase-economy).

    It refuses rather than guesses on anything unexpected: a draft isn't
    collectable yet, a void invoice isn't owed, and a paid one is already
    settled — each is a 409 with a sentence the customer can act on, not a
    checkout for $0.
    """
    from integrations import stripe_payments as sp

    if not sp.can_take_payments():
        # 503, not 400: nothing is wrong with the request. The server isn't set
        # up, and the page should fall back to "call/text us". Checked BEFORE
        # the row is locked so a misconfigured server doesn't take locks.
        raise HTTPException(status_code=503,
                            detail="Online payment isn't set up yet.")

    # LOCKED FOR THE WHOLE DECISION, and this is the only thing that makes
    # one-live-session-per-invoice true. Reading the row, asking Stripe about
    # the existing session, creating a new one and writing its id are four
    # steps; without the lock two concurrent taps both read "no live session",
    # both create one at Stripe, and the second write overwrites the first id
    # while BOTH urls stay chargeable. The columns are not unique and could not
    # fix this anyway — the duplicate is created at Stripe, not in this table.
    # SQLite ignores FOR UPDATE (it serializes writers anyway).
    #
    # The lock is held across a network call, which is not free: it pins the
    # row for up to the Stripe timeout (30s). Accepted deliberately — it is one
    # rarely-contended row, the endpoint is metered at 20/hour, and the thing
    # being prevented is charging somebody twice.
    inv = (db.query(Invoice)
           .filter(Invoice.public_token == token)
           .populate_existing().with_for_update().first())
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    status = (inv.status or "").lower()
    if status == "paid":
        raise HTTPException(status_code=409, detail="This invoice is already paid.")
    if status == "void":
        raise HTTPException(status_code=409, detail="This invoice was cancelled.")
    if status == "draft":
        raise HTTPException(status_code=409,
                            detail="This invoice hasn't been sent yet.")

    due = _amount_due(inv)
    if due <= 0:
        raise HTTPException(status_code=409, detail="There's nothing left to pay.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if inv.stripe_checkout_session_id and inv.stripe_checkout_expires_at \
            and inv.stripe_checkout_expires_at > now:
        existing = sp.retrieve_session(inv.stripe_checkout_session_id)

        # A FAILED READ IS "UNKNOWN", NOT "GONE". Minting a fresh session here
        # is how a bank debit already in flight becomes a second bank debit, so
        # this refuses and asks them to try again instead. The earlier version
        # fell through on purpose ("don't refuse to take the money"), which is
        # the wrong side to err on: a customer retrying in a minute is a
        # nuisance, a customer debited twice is a refund and a phone call.
        if existing is None:
            raise HTTPException(
                status_code=503,
                detail="We couldn't check on this invoice's payment just now. "
                       "Please try again in a moment.")

        sess_status = (existing.get("status") or "").lower()
        pay_status = (existing.get("payment_status") or "").lower()

        if sess_status == "open" and existing.get("url"):
            return {"url": existing["url"], "reused": True}

        # COMPLETE BUT NOT PAID is the ACH window, and it is days long. Stripe
        # flips a session to `complete` the moment the customer submits the
        # form; for a bank debit the money then takes days to clear, so the
        # session is neither open (not reusable) nor paid (invoice still owed).
        # Treating that as "no live session" and minting a new one is exactly
        # the double-debit this endpoint exists to prevent — both would settle.
        # So it is a hold, released by `expires_at` passing or by the
        # async_payment_failed event clearing the stored session.
        if sess_status == "complete" and pay_status != "paid":
            raise HTTPException(
                status_code=409,
                detail="A payment for this invoice is still going through. "
                       "Bank transfers can take a few business days to clear — "
                       "you won't be charged twice, and there's nothing more to "
                       "do. Call us if it hasn't cleared in a week.")

        # Paid at Stripe but the invoice hasn't caught up (webhook in flight or
        # lost). Never a reason to charge them again.
        if sess_status == "complete" and pay_status == "paid":
            raise HTTPException(
                status_code=409,
                detail="This invoice has been paid — we're just confirming it. "
                       "Nothing more to do.")

        # Anything else (expired) falls through to a fresh session.

    success_url, cancel_url = _checkout_urls(token)
    res = sp.create_checkout_session(
        amount_cents=sp.dollars_to_cents(due),
        invoice_number=inv.invoice_number or f"#{inv.id}",
        invoice_id=inv.id,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"brightbase_org_id": str(inv.org_id or "")},
    )
    if not res["ok"]:
        logger.warning("[stripe] checkout refused for invoice %s: %s",
                       inv.id, res["error"])
        raise HTTPException(status_code=502,
                            detail="Couldn't open the payment page just now. "
                                   "Please try again, or call us.")

    inv.stripe_checkout_session_id = res["id"]
    inv.stripe_checkout_expires_at = res["expires_at"]
    db.commit()
    return {"url": res["url"], "reused": False}


def record_checkout_payment(db: Session, session_obj: dict, *,
                            event_type: str = "") -> dict:
    """Apply a VERIFIED Stripe Checkout event to its invoice.

    Called only from the webhook, after the signature has been checked. It is
    not an endpoint: there is no route by which a browser can reach this.

    PAYMENT_STATUS IS THE GATE, NOT THE EVENT NAME, and that distinction is
    the whole correctness of the ACH path. `checkout.session.completed` fires
    the moment the customer finishes the form — for a card that means the money
    is captured, but for a bank debit it means a multi-day debit has been
    *initiated*, and the session arrives with `payment_status: "unpaid"`.
    Marking an invoice paid on the event name would book ACH money that has not
    settled and can still fail, which is the worst kind of wrong number: the
    revenue figure says collected and the bank disagrees. So the invoice flips
    on `payment_status == "paid"` only — which is true immediately for a card,
    and arrives later for a bank debit as
    `checkout.session.async_payment_succeeded`.

    Resolves the invoice from `client_reference_id` (what we sent, echoed back
    on a signature-verified request), then falls back to the stored session id.
    An unknown session is logged and ignored, not an error — the same Stripe
    account can serve more than one thing.
    """
    sess_id = session_obj.get("id")
    ref = session_obj.get("client_reference_id")
    pi = session_obj.get("payment_intent")
    pi = pi if isinstance(pi, str) else (pi or {}).get("id")

    inv = None
    if ref:
        try:
            inv = db.query(Invoice).filter(Invoice.id == int(ref)).first()
        except (TypeError, ValueError):
            inv = None
    if inv is None and sess_id:
        inv = (db.query(Invoice)
               .filter(Invoice.stripe_checkout_session_id == sess_id).first())
    if inv is None:
        logger.info("[stripe] %s for an unknown invoice (session=%s, ref=%s)",
                    event_type or "checkout event", sess_id, ref)
        return {"ok": True, "ignored": True}

    if pi and not inv.stripe_payment_intent_id:
        inv.stripe_payment_intent_id = pi

    # THE BANK DEBIT FAILED. Release the hold: `start_checkout` refuses to mint
    # a new session while a completed-but-unsettled one is on the row, which is
    # right while the debit is in flight and wrong once it has bounced — it
    # would lock the customer out of paying at all. Clearing the stored session
    # is what lets them try again with a different method.
    if event_type == "checkout.session.async_payment_failed":
        inv.stripe_checkout_session_id = None
        inv.stripe_checkout_expires_at = None
        db.commit()
        logger.warning("[stripe] the bank payment for invoice %s failed — "
                       "invoice left open and the checkout hold released",
                       inv.id)
        return {"ok": True, "invoice_id": inv.id, "paid": False, "failed": True}

    paid = (session_obj.get("payment_status") or "").lower() == "paid"
    if not paid:
        # Initiated, not settled. The handle is already recorded above so the
        # money can be traced and the later async event matched; the invoice is
        # deliberately left alone.
        db.commit()
        logger.info("[stripe] %s for invoice %s is not settled yet "
                    "(payment_status=%s) — invoice left open",
                    event_type or "checkout event", inv.id,
                    session_obj.get("payment_status"))
        return {"ok": True, "invoice_id": inv.id, "paid": False}

    # WHAT THEY ACTUALLY PAID, against what the invoice now says it wants.
    #
    # These can differ, and the way they differ loses money silently. A session
    # is created for the total at that moment; if the office then edits the
    # items, tax or discount, Stripe keeps charging the OLD amount while the
    # row carries the new one. Checking only `payment_status` would mark a
    # repriced $600 invoice fully paid on a $450 charge and write "$600
    # received" to the timeline — the invoice reads collected and the shortfall
    # is invisible. Repricing now clears the session (see `update_invoice`), so
    # this is the backstop for one already in flight.
    #
    # Over-payment (the invoice was repriced DOWN) still settles: they have
    # covered it, and the surplus is a refund decision for a person, not a
    # reason to leave the invoice open.
    from integrations import stripe_payments as sp

    # CURRENCY FIRST, and it is belt-and-braces by design. Every session this
    # app creates is `usd` with no branch that varies it, so a mismatch is not
    # reachable without a code change — which is exactly why it is worth
    # asserting rather than assuming: the day somebody adds a second currency,
    # `amount_total` silently stops being comparable to a dollar total and
    # 500 CAD would settle a $500 invoice. Refuse instead of guessing at a
    # conversion we have no rate for.
    currency = (session_obj.get("currency") or "").lower()
    if currency and currency != "usd":
        db.commit()   # keep the payment_intent handle recorded above
        logger.error("[stripe] invoice %s got a %s payment; this app only "
                     "prices in USD, so it cannot be reconciled automatically "
                     "— invoice left open for a person",
                     inv.id, currency.upper())
        return {"ok": True, "invoice_id": inv.id, "paid": False,
                "currency_mismatch": currency}

    amount_total = session_obj.get("amount_total")
    expected_cents = sp.dollars_to_cents(inv.total)
    actual_cents = None
    try:
        actual_cents = int(amount_total) if amount_total is not None else None
    except (TypeError, ValueError):
        actual_cents = None

    if actual_cents is not None and actual_cents < expected_cents:
        # Money arrived, but not enough. Record the REAL figure and leave the
        # invoice owed: booking a short payment as full collection is the one
        # outcome nobody can spot later. A person decides whether to accept it
        # or bill the difference.
        short = (expected_cents - actual_cents) / 100.0
        db.add(Message(
            client_id=inv.client_id,
            channel="payment",
            direction="inbound",
            from_addr="", to_addr="",
            body=(f"Partial payment received: ${actual_cents / 100:,.2f} of "
                  f"${inv.total:,.2f} (online, Stripe) — ${short:,.2f} still "
                  f"owed. The invoice was repriced after the payment link was "
                  f"sent; this invoice is NOT marked paid."),
            status="received",
            org_id=inv.org_id,  # BB-MT-01
        ))
        db.commit()
        logger.warning("[stripe] invoice %s was paid %s cents but wants %s — "
                       "left open, partial payment recorded",
                       inv.id, actual_cents, expected_cents)
        return {"ok": True, "invoice_id": inv.id, "paid": False,
                "underpaid": True, "paid_cents": actual_cents,
                "expected_cents": expected_cents}

    res = _record_payment(
        db, inv,
        body=f"Payment received: ${inv.total} (online, Stripe)",
        payment_intent_id=pi,
    )
    return {"ok": True, "invoice_id": inv.id, "paid": True,
            "already_paid": bool(res.get("already_paid"))}
