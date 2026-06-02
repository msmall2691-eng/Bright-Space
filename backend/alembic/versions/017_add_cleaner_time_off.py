"""017 — add cleaner_time_off table.

Cleaner availability: a date range a cleaner is unavailable (vacation/sick).
The scheduling guard blocks assigning a cleaner to a job on a day they're off.

Revision ID: 017_cleaner_time_off
"""
from alembic import op
import sqlalchemy as sa

revision = "017_cleaner_time_off"
down_revision = "016_quote_public_token"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cleaner_time_off",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("cleaner_id", sa.String(), nullable=False),
        sa.Column("cleaner_name", sa.String(), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "idx_cleaner_timeoff_lookup", "cleaner_time_off",
        ["cleaner_id", "start_date", "end_date"],
    )


def downgrade():
    op.drop_index("idx_cleaner_timeoff_lookup", table_name="cleaner_time_off")
    op.drop_table("cleaner_time_off")
