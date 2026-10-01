"""
Alembic migration: online invoice payment via Stripe Checkout, and retire Square

TWO THINGS, and they are the same decision from opposite ends.

ADDS the three columns the hosted-Checkout path needs on `invoices`:

  * stripe_checkout_session_id  — the live session, so one invoice has at most
    one open session. Two tabs on the same invoice must not become two
    payments, and reusing an open session is how that is prevented.
  * stripe_checkout_expires_at  — the cached half of "is that session still
    open", so the reuse decision costs no Stripe call (brightbase-economy).
    Naive UTC, matching `paid_at` on this same table rather than the tz-aware
    `dunning_*` columns: it is only compared against "now", and a naive/aware
    mix is a TypeError on the path a customer is trying to pay through.
  * stripe_payment_intent_id    — "which payment was that", the same job
    `SubPayout.external_ref` does on the payout side. Written by the webhook.

All three nullable and additive, so old code ignores them: zero-downtime.

CLEARS the orphaned Square settings rows. `integrations/square.py` was a Labor
API *timecard* client for the Square Payroll export, and that export was
deleted in Sept 2026 because a timecard asserts an hourly wage and an
employment relationship — the one thing a subcontractor arrangement cannot say
(see modules/payroll/router.py). The code is removed in this same change, which
leaves a live Square access token in `app_settings` that nothing can legitimately
read. A credential retained for a deleted feature is one nobody will think to
rotate, so it goes with the code that used it.

The token is encrypted at rest and masked by the status endpoint, so this is
housekeeping rather than an incident — but it is housekeeping with a credential
in it.

DOWNGRADE restores the columns' shape and NOT the Square rows. A deleted secret
is not recoverable from a downgrade, and it should not be: rotate the token in
Square's dashboard instead of trying to put this one back.

Alembic version: 122
"""

from alembic import op
import sqlalchemy as sa


revision = "122_invoice_stripe_checkout"
down_revision = "121_open_unassigned_recurring"
branch_labels = None
depends_on = None


# Every app_settings key the Square timecard integration owned. The three
# `square_job_*` rows are wage-job titles for timecards; the two `_cache` rows
# are what the "Test connection" button memoized.
_SQUARE_SETTING_KEYS = (
    "square_access_token",
    "square_location_id",
    "square_environment",
    "square_job_residential",
    "square_job_rental",
    "square_job_weekend",
    "square_locations_cache",
    "square_job_titles_cache",
)


def upgrade() -> None:
    op.add_column("invoices", sa.Column("stripe_checkout_session_id",
                                        sa.String(length=128), nullable=True))
    op.add_column("invoices", sa.Column("stripe_checkout_expires_at",
                                        sa.DateTime(), nullable=True))
    op.add_column("invoices", sa.Column("stripe_payment_intent_id",
                                        sa.String(length=128), nullable=True))
    # Both are looked up by the webhook (the repair path when a session id is
    # all we have) — index them rather than table-scan invoices. NOT unique:
    # a reversed/retried payment can legitimately reuse an id, and a unique
    # index would turn that into a 500 on a webhook Stripe then retries for days.
    op.create_index("ix_invoices_stripe_checkout_session_id", "invoices",
                    ["stripe_checkout_session_id"])
    op.create_index("ix_invoices_stripe_payment_intent_id", "invoices",
                    ["stripe_payment_intent_id"])

    # Named parameters, not an f-string: these are literals today, but a
    # DELETE assembled by string formatting is a habit that outlives its
    # safe inputs.
    keys = list(_SQUARE_SETTING_KEYS)
    bind = op.get_bind()
    bind.execute(
        sa.text("DELETE FROM app_settings WHERE key IN :keys").bindparams(
            sa.bindparam("keys", value=keys, expanding=True)
        )
    )


def downgrade() -> None:
    op.drop_index("ix_invoices_stripe_payment_intent_id", table_name="invoices")
    op.drop_index("ix_invoices_stripe_checkout_session_id", table_name="invoices")
    op.drop_column("invoices", "stripe_payment_intent_id")
    op.drop_column("invoices", "stripe_checkout_expires_at")
    op.drop_column("invoices", "stripe_checkout_session_id")
    # Deliberately does NOT restore the Square settings rows — see the module
    # docstring. The access token is gone; rotate it in Square if you ever want
    # that integration back, rather than expecting a downgrade to return it.
