"""Job-completion side effects shared by every "mark complete" path.

Three routes can land a job on status='completed' — the office status PATCH,
the office checklist endpoint (POST /api/jobs/{id}/complete), and the crew's
own mark-done (POST /api/crew/jobs/{id}/complete). They must all produce the
same downstream result, so the shared piece lives here rather than being
re-implemented per router (and rather than cross-importing a private helper
out of scheduling/router.py, which is trying to shrink — R6).
"""
import logging
from datetime import datetime, timedelta, timezone
from utils.dates import business_today

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def auto_create_draft_invoice(db: Session, job) -> None:
    """Auto-create a draft Invoice the first time a job lands on 'completed'.

    Idempotent: skip if an Invoice already exists for this Job. Uses the
    source Quote's items when available; otherwise emits a placeholder line.
    Called from every completion path (office status PATCH, office checklist
    endpoint, crew mark-done) so invoicing doesn't depend on which UI marked
    the job done."""
    try:
        from database.models import Invoice, Quote, RecurringSchedule
        existing_inv = db.query(Invoice).filter(Invoice.job_id == job.id).first()
        if existing_inv:
            return
        # Pull line items + tax from the originating quote when the job came
        # from one (quotes are integer-keyed, matching Job.quote_id);
        # otherwise build a default single-line invoice.
        #
        # Recurring-generated jobs never carry their own quote_id (Job.quote_id
        # is unique, and one schedule fans out into many jobs), so look up the
        # *schedule's* quote instead — otherwise every recurring visit falls
        # through to the $0 placeholder below even when the series was set up
        # from a priced quote.
        quote = db.query(Quote).filter(Quote.id == job.quote_id).first() if job.quote_id else None
        if not quote and job.recurring_schedule_id:
            sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == job.recurring_schedule_id).first()
            if sched and sched.quote_id:
                quote = db.query(Quote).filter(Quote.id == sched.quote_id).first()
        items = (quote.items if (quote and quote.items) else [{
            "name": job.title or "Cleaning",
            "qty": 1,
            "unit_price": 0,
            "description": "",
        }])
        subtotal = sum(float(i.get("qty", 1)) * float(i.get("unit_price", 0)) for i in items)
        # `is not None`, not truthiness: a quote with tax_rate=0 is explicitly
        # tax-exempt (0 is also the column default) — treating 0 as "unset" and
        # falling back to 5.5% billed tax to customers who owe none.
        tax_rate = float(quote.tax_rate) if (quote and quote.tax_rate is not None) else 5.5
        tax = round(subtotal * (tax_rate / 100), 2)
        total = round(subtotal + tax, 2)
        # Net 14 counted in business days-of-the-calendar, not UTC ones: from
        # 8pm here the UTC date is already tomorrow, so a job closed in the
        # evening quietly got net-15 while the same job closed at 2pm got
        # net-14. due_date is read back against business_today() by AR aging
        # and by dunning, so it has to be a business-local date.
        due_date = (business_today() + timedelta(days=14)).isoformat()
        invoice = Invoice(
            client_id=job.client_id,
            job_id=job.id,
            opportunity_id=job.opportunity_id,
            org_id=job.org_id,  # MT-2: inherit the job's workspace (was unset → NULL-org invoice visible to every tenant)
            items=items,
            subtotal=round(subtotal, 2),
            tax_rate=tax_rate,
            tax=tax,
            total=total,
            status="draft",
            due_date=due_date,
            notes=job.notes or "",
        )
        db.add(invoice)
        db.flush()  # materialize the PK so the number can derive from it
        # REQUIRED: without a number, send_invoice / reminders mail the customer
        # "Invoice None". Shared helper keeps the manual + auto paths identical.
        from modules.invoicing.router import assign_invoice_number
        assign_invoice_number(db, invoice)
        db.commit()
        logger.info(f"[auto-invoice] created draft Invoice id={invoice.id} number={invoice.invoice_number} from completed Job {job.id}")
    except Exception as e:
        logger.warning(f"[auto-invoice] failed for job {job.id}: {e}")
