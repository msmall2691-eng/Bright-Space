"""Crew training/docs library: crew_docs (crew app Phase 5).

Office-authored reference documents — cleaning standards, chemical guides,
onboarding, policies — read by cleaners in the crew app's Learn tab.
Plain-text bodies only (no attachments/rich markup) so the library stays
maintainable by one person. Published flag gates crew visibility; pinned
floats a doc to the top of the tab.

Additive (R8): new table only. org_id pairs with the TENANT_TABLES entry.

Revision ID: 086_crew_docs
Revises: 085_cleaner_availability
"""
from alembic import op
import sqlalchemy as sa


revision = "086_crew_docs"
down_revision = "085_cleaner_availability"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "crew_docs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("url", sa.String(length=500), nullable=True),
        sa.Column("category", sa.String(length=40), nullable=False, server_default="how-to"),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("published", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_crew_docs_org_id", "crew_docs", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_crew_docs_org_id", table_name="crew_docs")
    op.drop_table("crew_docs")
