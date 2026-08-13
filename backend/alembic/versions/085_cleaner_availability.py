"""Crew weekly availability: cleaner_availability (crew app Phase 4).

Per-cleaner weekly pattern — {"mon": ["am","pm"], ..., "sun": []} — set by
the cleaner in the crew app's Me tab. Owner decision #3: per-day AM/PM/Off,
and it renders as a SIGNAL in the office's assign surfaces ("usually off"),
never a hard block. One-off absences remain CleanerTimeOff date ranges;
this table is the recurring shape of a cleaner's week. A missing row means
"never set a pattern" (unknown), which renders as nothing — not as off.

Additive (R8): new table only. org_id pairs with the TENANT_TABLES entry.

Revision ID: 085_cleaner_availability
Revises: 084_job_open_for_claims
"""
from alembic import op
import sqlalchemy as sa


revision = "085_cleaner_availability"
down_revision = "084_job_open_for_claims"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cleaner_availability",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("cleaner_id", sa.String(), nullable=False),
        sa.Column("week", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("cleaner_id", name="uq_cleaner_availability_cleaner"),
    )
    op.create_index("ix_cleaner_availability_org_id", "cleaner_availability", ["org_id"])
    op.create_index("ix_cleaner_availability_cleaner_id", "cleaner_availability", ["cleaner_id"])


def downgrade() -> None:
    op.drop_index("ix_cleaner_availability_cleaner_id", table_name="cleaner_availability")
    op.drop_index("ix_cleaner_availability_org_id", table_name="cleaner_availability")
    op.drop_table("cleaner_availability")
