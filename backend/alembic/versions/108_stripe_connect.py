"""Where a subcontractor's Stripe payout account lives.

BrightBase pays subs from a ledger (migration 099) whose only rail marks a
payout `sent` and never `paid`, because a human writes the cheque and this code
cannot know whether they did. Stripe is the first rail that can know.

The second reason, and the one that actually decided it: **the W-9 problem.**
The schema deliberately has no SSN or TIN field — and a sole proprietor's W-9
has their SSN printed on it, so the rule was honoured in the columns and
defeated by `sub_documents`, which stores the scan as bytes in the application
database. Stripe collects tax identity on its own hosted page, verifies the
name/TIN against IRS records, and *will not return it*: "Stripe doesn't share
the updated sensitive PII (such as SSN or EIN) from accounts with your platform
through the API for security reasons." So the honest claim is not that nobody
can ever see an SSN — it is that the SSN leaves an app database that anything
with a connection string can read, and moves behind Stripe's team roles and 2FA.

THREE COLUMNS, ALL CACHE EXCEPT THE FIRST.

  * `stripe_account_id` is the only fact — the connected account this person
    owns. Everything else here is a copy of what Stripe last told us.
  * `stripe_payouts_enabled` and `stripe_requirements` are cached from
    `account.updated` webhooks rather than fetched per screen render
    (brightbase-economy: no API call to render a crew page, no polling tick —
    scheduling-invariants R1, baseline 13).
  * `stripe_synced_at` is when that copy was written, so a stale cache is
    visible as staleness rather than mistaken for truth.

NOT A GATE. Deliberately not in `sub_vetting.REQUIRED_KINDS`, and no column
here feeds `blocking_requirements`. "You must open a Stripe account to be
eligible for work" is a condition of engagement the arrangement does not need
and should not have — the manual rail stays registered, and a sub mid-onboarding
or unwilling still gets paid the old way. Payment method is a commercial detail
between two businesses, not a qualification.

Revision ID: 108_stripe_connect
Revises: 107_job_helpers
"""
import sqlalchemy as sa
from alembic import op

revision = "108_stripe_connect"
down_revision = "107_job_helpers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # acct_... is 21 chars today; 64 is room for Stripe changing its mind.
    op.add_column("users", sa.Column("stripe_account_id", sa.String(64), nullable=True))
    op.add_column("users", sa.Column("stripe_payouts_enabled", sa.Boolean(),
                                     nullable=False, server_default=sa.false()))
    # What Stripe is still waiting for, verbatim from the account's
    # `requirements` hash. Text rather than JSON: it is displayed and logged,
    # never queried, and a JSON column would invite someone to filter on it.
    op.add_column("users", sa.Column("stripe_requirements", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("stripe_synced_at", sa.DateTime(), nullable=True))
    op.create_index("ix_users_stripe_account_id", "users", ["stripe_account_id"])


def downgrade() -> None:
    op.drop_index("ix_users_stripe_account_id", table_name="users")
    op.drop_column("users", "stripe_synced_at")
    op.drop_column("users", "stripe_requirements")
    op.drop_column("users", "stripe_payouts_enabled")
    op.drop_column("users", "stripe_account_id")
