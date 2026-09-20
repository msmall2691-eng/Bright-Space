"""Client + property archive lifecycle (Jobber-style).

Adds a timestamped, reversible archive marker to clients and properties so the
office can take a customer (or one property) out of every active workflow in one
action — hidden from active lists, their work stopped — while all history and
invoices stay intact and it is one-click reversible.

- Client: `archived_at` / `archived_by`. Archived = archived_at IS NOT NULL.
  Orthogonal to the existing `status` (lead/active/inactive) sales sub-stage.
- Property: `archived_at` / `archived_by`. `active` is already the archive
  predicate the ticks + get_properties honor; these record when/who and tell a
  deliberate archive apart from a legacy active=False.

Additive and inert until an archive sets them (nullable, no backfill — absent
reads as "not archived", so every existing row behaves exactly as today). No new
tenant table: clients + properties already carry org_id and ride the existing
RLS policy, so no TENANT_TABLES / apply_org_rls change. Scheduling-invariants R7
holds — archiving stops generation and cancels-pending future visits through the
service layer; nothing here deletes a Job. archived_at is indexed (it becomes a
hot active-list filter). archived_by → users.id ON DELETE SET NULL.

Revision ID: 119_client_property_archive
Revises: 118_ical_event_dismissed
"""
import sqlalchemy as sa
from alembic import op

revision = "119_client_property_archive"
down_revision = "118_ical_event_dismissed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("archived_at", sa.DateTime(), nullable=True))
    op.add_column("clients", sa.Column("archived_by", sa.Integer(), nullable=True))
    op.create_index("ix_clients_archived_at", "clients", ["archived_at"])
    op.create_foreign_key("fk_clients_archived_by_users", "clients", "users",
                          ["archived_by"], ["id"], ondelete="SET NULL")

    op.add_column("properties", sa.Column("archived_at", sa.DateTime(), nullable=True))
    op.add_column("properties", sa.Column("archived_by", sa.Integer(), nullable=True))
    op.create_index("ix_properties_archived_at", "properties", ["archived_at"])
    op.create_foreign_key("fk_properties_archived_by_users", "properties", "users",
                          ["archived_by"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    op.drop_constraint("fk_properties_archived_by_users", "properties", type_="foreignkey")
    op.drop_index("ix_properties_archived_at", table_name="properties")
    op.drop_column("properties", "archived_by")
    op.drop_column("properties", "archived_at")

    op.drop_constraint("fk_clients_archived_by_users", "clients", type_="foreignkey")
    op.drop_index("ix_clients_archived_at", table_name="clients")
    op.drop_column("clients", "archived_by")
    op.drop_column("clients", "archived_at")
