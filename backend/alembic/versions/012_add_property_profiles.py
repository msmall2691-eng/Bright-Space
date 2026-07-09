"""Add Property Intelligence System (never adopted — now a no-op)

Revision ID: 012_add_property_profiles
Revises: 011_property_checklist_template
Create Date: 2026-05-26 15:00:00.000000

This migration originally created property_profiles / property_photos /
time_estimates_history plus four Postgres ENUM types for a "Property
Intelligence System" feature. That feature was never wired up: there is no
ORM model for any of these tables anywhere in database/models.py, and no
router reads or writes them. Worse, property_photos and time_estimates_history
declare a foreign key to a `crews` table that is never created by any
migration — so this migration could never have executed successfully against
a real, empty Postgres database (see docs/mt3-rls-validation.md's "Known
issue"). It only ever appeared to work because production's schema was
bootstrapped via Base.metadata.create_all() (which doesn't include these
orphaned tables) and Alembic was stamped past this revision without ever
truly replaying it.

Turned into a no-op rather than deleted outright so existing `alembic_version`
rows already stamped at this revision (or past it) keep resolving to a valid
revision id. If this feature is wanted later, design it against the current
schema (integer PKs, no `crews` table) as a fresh migration instead of
reviving this one.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '012_add_property_profiles'
down_revision = '011'
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
