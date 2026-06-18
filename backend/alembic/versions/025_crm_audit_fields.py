"""025 — CRM audit fields + Property structured size columns.

Twenty-aligned ActorMetadata: created_by / updated_by (FK users) + updated_at on
the core mutable tables (clients, properties, lead_intakes; invoices already had
updated_at). Plus Property.bedrooms/bathrooms/square_footage so convert-to-quote
can carry the customer's structured request onto the property.

All additive + nullable + idempotent (guards each column), so it applies cleanly
to a drifted prod DB and re-runs safely.

Revision ID: 025_crm_audit_fields
"""
from alembic import op
import sqlalchemy as sa

revision = "025_crm_audit_fields"
down_revision = "024_quote_archived_at"
branch_labels = None
depends_on = None


def _cols(bind, table):
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _add(bind, table, column, coltype):
    if column not in _cols(bind, table):
        op.add_column(table, sa.Column(column, coltype, nullable=True))


def _drop(bind, table, column):
    if column in _cols(bind, table):
        op.drop_column(table, column)


# (table, column, type) — all nullable, additive.
_AUDIT = [
    ("clients", "updated_at", sa.DateTime()),
    ("clients", "created_by", sa.Integer()),
    ("clients", "updated_by", sa.Integer()),
    ("properties", "bedrooms", sa.Integer()),
    ("properties", "bathrooms", sa.Integer()),
    ("properties", "square_footage", sa.Integer()),
    ("properties", "updated_at", sa.DateTime()),
    ("properties", "created_by", sa.Integer()),
    ("properties", "updated_by", sa.Integer()),
    ("lead_intakes", "updated_at", sa.DateTime()),
    ("lead_intakes", "created_by", sa.Integer()),
    ("lead_intakes", "updated_by", sa.Integer()),
    ("invoices", "created_by", sa.Integer()),
    ("invoices", "updated_by", sa.Integer()),
]


def upgrade():
    bind = op.get_bind()
    for table, column, coltype in _AUDIT:
        _add(bind, table, column, coltype)


def downgrade():
    bind = op.get_bind()
    for table, column, _ in reversed(_AUDIT):
        _drop(bind, table, column)
