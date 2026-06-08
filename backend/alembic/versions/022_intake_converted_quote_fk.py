"""022 — add the FK constraint for lead_intakes.converted_quote_id.

Migration 021 added the column as a plain integer, but the ORM declares it a
foreign key to quotes.id. Add the constraint so Alembic-built (production)
databases enforce the relationship and can't leave a dangling conversion trace.

Revision ID: 022_intake_converted_quote_fk
"""
from alembic import op

revision = "022_intake_converted_quote_fk"
down_revision = "021_quote_followup_traceability"
branch_labels = None
depends_on = None

_FK = "fk_lead_intakes_converted_quote_id"


def upgrade():
    # ON DELETE SET NULL: deleting a quote shouldn't delete the intake, just
    # clear the (now meaningless) back-reference.
    op.create_foreign_key(
        _FK, "lead_intakes", "quotes",
        ["converted_quote_id"], ["id"], ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint(_FK, "lead_intakes", type_="foreignkey")
