"""Crew profile: emergency contact on users.

The Me tab (crew app Phase 1) lets a cleaner keep their own contact info
current — name and phone already exist on users; this adds the emergency
contact pair, which the office needs on file for people working alone in
other people's homes.

Additive only: two nullable columns, no backfill, no RLS change (users is
not org-fenced — it's the login table).

Revision ID: 082_user_emergency_contact
Revises: 081_job_photos
"""
from alembic import op
import sqlalchemy as sa


revision = "082_user_emergency_contact"
down_revision = "081_job_photos"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("emergency_contact_name", sa.String(), nullable=True))
    op.add_column("users", sa.Column("emergency_contact_phone", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "emergency_contact_phone")
    op.drop_column("users", "emergency_contact_name")
