"""Week-anchored crew availability: cleaner_week_availability (Phase 4b).

Owner feedback on the live weekly-template editor: the grid should say WHICH
week it covers, cleaners should set specific weeks in advance, and the week
already underway must be locked so the office schedules against a stable
picture.

One row per (cleaner, week). week_start is the MONDAY the week begins —
matching the {mon..sun}-keyed week JSON and the crew pay week (the office
Schedule's Sunday-first strip is a display convention only; it consumes
availability per single date). A missing row means "use the recurring
template" (cleaner_availability, migration 085), which stays as the
default. The lock is enforced in the crew router (writes to current/past
weeks are rejected), not in the schema.

Additive (R8): new table only. org_id pairs with the TENANT_TABLES entry.

Revision ID: 087_cleaner_week_availability
Revises: 086_crew_docs
"""
from alembic import op
import sqlalchemy as sa


revision = "087_cleaner_week_availability"
down_revision = "086_crew_docs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cleaner_week_availability",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("cleaner_id", sa.String(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("week", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("cleaner_id", "week_start", name="uq_cleaner_week_availability"),
    )
    op.create_index("ix_cleaner_week_availability_org_id", "cleaner_week_availability", ["org_id"])
    op.create_index("ix_cleaner_week_availability_cleaner_id", "cleaner_week_availability", ["cleaner_id"])


def downgrade() -> None:
    op.drop_index("ix_cleaner_week_availability_cleaner_id", table_name="cleaner_week_availability")
    op.drop_index("ix_cleaner_week_availability_org_id", table_name="cleaner_week_availability")
    op.drop_table("cleaner_week_availability")
