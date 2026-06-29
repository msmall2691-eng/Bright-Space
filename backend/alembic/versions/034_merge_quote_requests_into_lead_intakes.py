"""034 — merge quote_requests into lead_intakes.

quote_requests and lead_intakes modeled the same thing (a customer web form
asking for service). quote_requests had ~6 references vs lead_intakes' ~58, and
both held name/email/phone/service_type. This collapses them onto lead_intakes:

  1. Add two LeadIntake columns that have no equivalent yet — property_id (FK)
     and preferred_time (free-text window).
  2. Copy every quote_requests row into lead_intakes, with source='quote_request'
     so its provenance survives, the quote_id FK becomes converted_quote_id, and
     the QuoteRequestStatus vocabulary is remapped to the LeadIntake one
     (pending->new, assigned->reviewed; quoted/archived already line up).
  3. Drop the RLS policy on quote_requests (Postgres only — no-op otherwise) and
     then drop the table.

Downgrade re-creates an empty quote_requests table with the same schema as
migration 018 plus the 027 org_id column and 028 RLS, and removes the two added
LeadIntake columns. It does NOT extract the migrated rows back out — they
remain in lead_intakes flagged source='quote_request' and would shadow any
restored data, so a true downgrade also requires manual cleanup if you ever
need it.

Revision ID: 034_merge_quote_requests_into_lead_intakes
"""
from alembic import op
import sqlalchemy as sa

from database.rls import apply_org_rls, drop_org_rls

revision = "034_merge_quote_requests_into_lead_intakes"
down_revision = "033_canonical_client_source"
branch_labels = None
depends_on = None


_STATUS_REMAP_SQL = """
    CASE qr.status
        WHEN 'pending'  THEN 'new'
        WHEN 'assigned' THEN 'reviewed'
        WHEN 'quoted'   THEN 'quoted'
        WHEN 'archived' THEN 'archived'
        ELSE 'new'
    END
"""


def _has_table(bind, name) -> bool:
    return name in set(sa.inspect(bind).get_table_names())


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade():
    bind = op.get_bind()

    # 1) Add the two LeadIntake columns we need to absorb everything QuoteRequest
    #    carried that didn't already have an equivalent.
    if not _has_column(bind, "lead_intakes", "property_id"):
        op.add_column(
            "lead_intakes",
            sa.Column("property_id", sa.Integer(), nullable=True),
        )
        # FK is optional on SQLite; create it on Postgres for prod parity.
        if bind.dialect.name == "postgresql":
            op.create_foreign_key(
                "fk_lead_intakes_property_id",
                "lead_intakes", "properties",
                ["property_id"], ["id"], ondelete="SET NULL",
            )
    if not _has_column(bind, "lead_intakes", "preferred_time"):
        op.add_column(
            "lead_intakes",
            sa.Column("preferred_time", sa.String(), nullable=True),
        )

    # 2) Copy quote_requests rows into lead_intakes. Skip if the source table
    #    is gone (fresh DB built straight from the current models).
    if _has_table(bind, "quote_requests"):
        # preferred_date is Date in quote_requests but String on lead_intakes;
        # cast to text so the insert is dialect-portable.
        op.execute(sa.text(f"""
            INSERT INTO lead_intakes (
                org_id, client_id, converted_quote_id, name, email, phone,
                service_type, property_id, message, preferred_date,
                preferred_time, source, status, created_at, updated_at
            )
            SELECT
                qr.org_id, qr.client_id, qr.quote_id, qr.requester_name,
                qr.requester_email, qr.requester_phone,
                qr.service_type, qr.property_id, qr.description,
                CAST(qr.preferred_date AS VARCHAR), qr.preferred_time,
                'quote_request', {_STATUS_REMAP_SQL},
                qr.created_at, qr.updated_at
            FROM quote_requests qr
        """))

        # 3) Tear down RLS on quote_requests (Postgres only, no-op elsewhere)
        #    so DROP TABLE doesn't trip over the policy, then drop the table.
        drop_org_rls(bind, tables=["quote_requests"])
        op.drop_table("quote_requests")


def downgrade():
    bind = op.get_bind()

    if not _has_table(bind, "quote_requests"):
        op.create_table(
            "quote_requests",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("org_id", sa.Integer(), nullable=True),
            sa.Column(
                "client_id", sa.Integer(),
                sa.ForeignKey("clients.id", ondelete="SET NULL"), nullable=True,
            ),
            sa.Column("requester_name", sa.String(length=255), nullable=False),
            sa.Column("requester_email", sa.String(length=255), nullable=False),
            sa.Column("requester_phone", sa.String(length=20), nullable=True),
            sa.Column(
                "property_id", sa.Integer(),
                sa.ForeignKey("properties.id", ondelete="SET NULL"), nullable=True,
            ),
            sa.Column("service_type", sa.String(length=100), nullable=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("preferred_date", sa.Date(), nullable=True),
            sa.Column("preferred_time", sa.String(length=50), nullable=True),
            sa.Column("status", sa.String(length=50), nullable=False, server_default="pending"),
            sa.Column(
                "quote_id", sa.Integer(),
                sa.ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True,
            ),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_quote_requests_org_id", "quote_requests", ["org_id"])
        # Re-enable RLS to match the original 028 policy.
        apply_org_rls(bind, tables=["quote_requests"])

    if _has_column(bind, "lead_intakes", "preferred_time"):
        op.drop_column("lead_intakes", "preferred_time")
    if _has_column(bind, "lead_intakes", "property_id"):
        if bind.dialect.name == "postgresql":
            try:
                op.drop_constraint(
                    "fk_lead_intakes_property_id", "lead_intakes",
                    type_="foreignkey",
                )
            except Exception:
                pass
        op.drop_column("lead_intakes", "property_id")
