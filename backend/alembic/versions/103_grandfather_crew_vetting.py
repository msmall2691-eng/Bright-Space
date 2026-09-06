"""
Don't lock the existing crew out of their own app.

The vetting gate (098) was designed for a bench being RECRUITED: nobody starts
without a W-9, a certificate of insurance and a signed agreement. Switched on
over a live business it did something else — every cleaner already on the books
lost the ability to claim an open job overnight, for paperwork nobody had asked
them for yet. The office had created an outage for itself, and the only way out
was a round of uploads it hadn't planned.

So enforcement gets a start date, and this sets it to the day it went in. A
crew account that existed before then keeps working; anyone onboarded after
goes through the gate as designed.

This is a GRANDFATHER CLAUSE, NOT AN OFF SWITCH. Everywhere the office looks,
an exempt person still reads as having an incomplete file, because the
documents genuinely are missing and hiding that is how an uninsured person ends
up in a customer's house. It only stops them being blocked TODAY.

Clearing this setting applies the gate to everybody — which is what to do once
the documents are actually in.

Idempotent: it never overwrites a value the office has already chosen.

Revision ID: 103_grandfather_crew_vetting
Revises: 102_sub_applications
"""
from datetime import date, timedelta

from alembic import op
import sqlalchemy as sa


revision = "103_grandfather_crew_vetting"
down_revision = "102_sub_applications"
branch_labels = None
depends_on = None

KEY = "crew_vetting_enforce_from"


def upgrade() -> None:
    bind = op.get_bind()
    existing = bind.execute(
        sa.text("SELECT value FROM app_settings WHERE key = :k"), {"k": KEY}
    ).fetchone()
    if existing is not None:
        return                      # the office already decided; leave it alone

    # Tomorrow, not today: a cleaner account created earlier THIS morning is
    # existing crew by any sensible reading, and a strict "before today" would
    # gate them. The comparison is `created < cutoff`, so this covers everyone
    # who exists at deploy time and nobody added afterwards.
    cutoff = (date.today() + timedelta(days=1)).isoformat()
    bind.execute(
        sa.text("INSERT INTO app_settings (key, value) VALUES (:k, :v)"),
        {"k": KEY, "v": cutoff},
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM app_settings WHERE key = :k"), {"k": KEY}
    )
