"""018 — integer-align the quotes domain.

Replaces the UUID-keyed quotes / quote_line_items / quote_requests / quote_emails
tables with integer-keyed tables matching clients/jobs/invoices/opportunities.
Line items move inline into a JSON ``items`` column on quotes (the same shape
Invoice.items uses), so the separate quote_line_items table is dropped.

Existing quote rows are dropped (confirmed disposable): UUID primary keys can't
be cast to integers, and nothing downstream referenced them successfully
(jobs.quote_id was already an Integer column pointed at a UUID PK).

Revision ID: 018_integerize_quotes
"""
from alembic import op
import sqlalchemy as sa

revision = "018_integerize_quotes"
down_revision = "017_cleaner_time_off"
branch_labels = None
depends_on = None


def upgrade():
    # Drop the UUID quote tables. CASCADE clears the dependent FK constraints
    # (jobs.quote_id, recurring_schedules.quote_id, quote_requests.quote_id,
    # quote_emails.quote_id) that pointed at the old UUID quotes.id.
    op.execute("DROP TABLE IF EXISTS quote_emails CASCADE")
    op.execute("DROP TABLE IF EXISTS quote_line_items CASCADE")
    op.execute("DROP TABLE IF EXISTS quote_requests CASCADE")
    op.execute("DROP TABLE IF EXISTS quotes CASCADE")

    op.create_table(
        "quotes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("intake_id", sa.Integer(), sa.ForeignKey("lead_intakes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("opportunity_id", sa.Integer(), sa.ForeignKey("opportunities.id", ondelete="SET NULL"), nullable=True),
        sa.Column("property_id", sa.Integer(), sa.ForeignKey("properties.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("quote_number", sa.String(length=50), nullable=False),
        sa.Column("public_token", sa.String(length=64), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("service_type", sa.String(length=100), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("items", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("subtotal", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tax_rate", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tax", sa.Float(), nullable=False, server_default="0"),
        sa.Column("discount", sa.Float(), nullable=False, server_default="0"),
        sa.Column("total", sa.Float(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=50), nullable=False, server_default="draft"),
        sa.Column("valid_until", sa.Date(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("viewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("declined_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by_name", sa.String(length=255), nullable=True),
        sa.Column("accepted_by_email", sa.String(length=255), nullable=True),
        sa.Column("custom_fields", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("quote_number", name="uq_quote_number"),
    )
    op.create_index("idx_quote_client_id", "quotes", ["client_id"])
    op.create_index("idx_quote_public_token", "quotes", ["public_token"], unique=True)

    op.create_table(
        "quote_emails",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("quote_id", sa.Integer(), sa.ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("recipient_email", sa.String(length=255), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("delivery_status", sa.String(length=50), nullable=False, server_default="sent"),
        sa.Column("email_id", sa.String(length=255), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("email_id", name="uq_quote_email_id"),
    )
    op.create_index("idx_quote_email_quote_id", "quote_emails", ["quote_id"])

    op.create_table(
        "quote_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="SET NULL"), nullable=True),
        sa.Column("requester_name", sa.String(length=255), nullable=False),
        sa.Column("requester_email", sa.String(length=255), nullable=False),
        sa.Column("requester_phone", sa.String(length=20), nullable=True),
        sa.Column("property_id", sa.Integer(), sa.ForeignKey("properties.id", ondelete="SET NULL"), nullable=True),
        sa.Column("service_type", sa.String(length=100), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("preferred_date", sa.Date(), nullable=True),
        sa.Column("preferred_time", sa.String(length=50), nullable=True),
        sa.Column("status", sa.String(length=50), nullable=False, server_default="pending"),
        sa.Column("quote_id", sa.Integer(), sa.ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade():
    # The UUID schema and its data are gone; downgrade just drops the integer
    # tables (no attempt to restore the old design).
    op.drop_table("quote_requests")
    op.drop_index("idx_quote_email_quote_id", table_name="quote_emails")
    op.drop_table("quote_emails")
    op.drop_index("idx_quote_public_token", table_name="quotes")
    op.drop_index("idx_quote_client_id", table_name="quotes")
    op.drop_table("quotes")
