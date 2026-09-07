"""A price on every job — what we CHARGE, kept apart from what we PAY.

THE GAP THIS CLOSES. A Job carried `posted_rate` and `agreed_rate` — what a
subcontractor is offered and what they settled for — and nothing at all for
what the customer is billed. `services/job_margin.py` says so in its own
docstring: a job's billed amount "lives in four different places depending on
how far along it is", and all four are inferred (an invoice raised later, the
quote it came from, what this house usually bills, or nothing). None of them
is somebody stating the price of the work when the work is booked.

The consequences were both visible from the owner's phone in one afternoon:
every invoice retyped from memory, and every open job on the crew's screen
reading "No price set — name yours when you ask".

THREE COLUMNS, and the separation between them is the point:

  properties.default_price      what a visit to THIS HOUSE usually bills.
  recurring_schedules.price     what a visit on THIS SERIES bills. One house
                                can carry a weekly clean and a quarterly deep
                                clean at very different prices, so the series
                                overrides the house rather than sharing it.
  jobs.price                    what THIS VISIT bills.

A job inherits — the series price, else the accepted quote's total, else the
house default — so the auto-generated work nobody types by hand (recurring
occurrences, rental turnovers off an iCal feed) arrives priced instead of
arriving blank. It is a starting value, not a link: editing the
house default never reaches back into a visit already on the books, because
a price somebody has already invoiced against must not move under them.

WHY NULLABLE, AND WHY NO BACKFILL. "We bill nothing for this" and "we don't
know what this bills" are different answers and only one of them means zero —
job_margin already draws that distinction and it holds here. Existing jobs
keep NULL and keep falling back to the invoice/quote/history sources they use
today; guessing a historical price and writing it into a money column would
make a computed number indistinguishable from one a person actually agreed.

FLOAT, NOT INTEGER CENTS. Against the general rule, and deliberately: every
money column already in this schema is Float — `invoices.subtotal/tax/total`,
`quotes.subtotal/total`, `sub_payouts.amount`, `jobs.posted_rate`,
`jobs.agreed_rate`, `properties.turnover_rate`. A lone cents column here would
need a conversion at every point this value meets an invoice total or sits
beside a posted rate, and those conversions are where rounding bugs are born.
Consistency with the six existing columns is worth more than the rule; moving
all of them is its own migration with its own round-trip test.

Revision ID: 110_job_and_property_price
Revises: 109_crew_photos
"""
import sqlalchemy as sa
from alembic import op

revision = "110_job_and_property_price"
down_revision = "109_crew_photos"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Additive and nullable: old code ignores a column it does not know about,
    # so this is zero-downtime on a single Railway container.
    op.add_column("properties", sa.Column("default_price", sa.Float(), nullable=True))
    op.add_column("recurring_schedules", sa.Column("price", sa.Float(), nullable=True))
    op.add_column("jobs", sa.Column("price", sa.Float(), nullable=True))


def downgrade() -> None:
    # Clean and lossless in the only sense that matters here: these columns are
    # new, so dropping them removes prices entered since the upgrade and
    # nothing that existed before it. Any price typed in between is gone —
    # which is the honest cost, and it is bounded by how long the column has
    # been live.
    op.drop_column("jobs", "price")
    op.drop_column("recurring_schedules", "price")
    op.drop_column("properties", "default_price")
