"""035 — retire quote_emails / quote_sms in favor of IntegrationEvent.

Quote send tracking lived in three places at once: the per-channel quote_emails
and quote_sms tables, and the general IntegrationEvent audit log (which already
supports entity_type='quote', provider in {'email','sms'}, action='send'). The
router was double-writing — to both the channel table AND IntegrationEvent —
which means most existing rows already have a counterpart audit entry. Collapse
onto IntegrationEvent so there's one source of truth.

  1. Backfill any quote_emails / quote_sms row that does NOT already have a
     matching IntegrationEvent (matched on entity_id + provider + external_id,
     falling back to recipient when external_id is null). Recipient lives in
     request_payload as 'to <addr>'; the channel status maps onto 'ok' / 'failed'.
  2. Drop the RLS policy on quote_emails (Postgres only; quote_sms never had
     one) and drop both tables.

Downgrade re-creates empty quote_emails / quote_sms tables matching the original
018/031 schema and re-applies RLS. It does NOT extract integration_events rows
back out — they remain in place, since the integration log is the live system
the app now reads from.

Revision ID: 035_quote_delivery_via_integration_events
"""
from alembic import op
import sqlalchemy as sa

from database.rls import apply_org_rls, drop_org_rls

revision = "035_quote_delivery_via_integration_events"
down_revision = "034_merge_quote_requests_into_lead_intakes"
branch_labels = None
depends_on = None


def _has_table(bind, name) -> bool:
    return name in set(sa.inspect(bind).get_table_names())


def _backfill_emails(bind):
    op.execute(sa.text("""
        INSERT INTO integration_events (
            org_id, entity_type, entity_id, provider, action, status,
            external_id, error_message, request_payload, created_at
        )
        SELECT
            qe.org_id, 'quote', qe.quote_id, 'email', 'send',
            CASE qe.delivery_status WHEN 'failed' THEN 'failed' ELSE 'ok' END,
            qe.email_id,
            qe.error_message,
            'to ' || qe.recipient_email,
            qe.sent_at
        FROM quote_emails qe
        WHERE NOT EXISTS (
            SELECT 1 FROM integration_events ie
            WHERE ie.entity_type = 'quote'
              AND ie.entity_id = qe.quote_id
              AND ie.provider = 'email'
              AND ie.action = 'send'
              AND (
                  (ie.external_id IS NOT NULL AND ie.external_id = qe.email_id)
                  OR (
                      ie.external_id IS NULL AND qe.email_id IS NULL
                      AND ie.request_payload = 'to ' || qe.recipient_email
                  )
              )
        )
    """))


def _backfill_sms(bind):
    op.execute(sa.text("""
        INSERT INTO integration_events (
            org_id, entity_type, entity_id, provider, action, status,
            external_id, error_message, request_payload, created_at
        )
        SELECT
            qs.org_id, 'quote', qs.quote_id, 'sms', 'send',
            CASE qs.delivery_status WHEN 'failed' THEN 'failed' ELSE 'ok' END,
            qs.message_sid,
            qs.error_message,
            'to ' || qs.recipient_phone,
            qs.sent_at
        FROM quote_sms qs
        WHERE NOT EXISTS (
            SELECT 1 FROM integration_events ie
            WHERE ie.entity_type = 'quote'
              AND ie.entity_id = qs.quote_id
              AND ie.provider = 'sms'
              AND ie.action = 'send'
              AND (
                  (ie.external_id IS NOT NULL AND ie.external_id = qs.message_sid)
                  OR (
                      ie.external_id IS NULL AND qs.message_sid IS NULL
                      AND ie.request_payload = 'to ' || qs.recipient_phone
                  )
              )
        )
    """))


def upgrade():
    bind = op.get_bind()

    if _has_table(bind, "quote_emails"):
        _backfill_emails(bind)
        drop_org_rls(bind, tables=["quote_emails"])
        op.drop_table("quote_emails")

    if _has_table(bind, "quote_sms"):
        _backfill_sms(bind)
        op.drop_table("quote_sms")


def downgrade():
    bind = op.get_bind()

    if not _has_table(bind, "quote_emails"):
        op.create_table(
            "quote_emails",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("org_id", sa.Integer(), nullable=True),
            sa.Column(
                "quote_id", sa.Integer(),
                sa.ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("recipient_email", sa.String(length=255), nullable=False),
            sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("delivery_status", sa.String(length=50), nullable=False, server_default="sent"),
            sa.Column("email_id", sa.String(length=255), nullable=True, unique=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_quote_emails_org_id", "quote_emails", ["org_id"])
        op.create_index("idx_quote_email_quote_id", "quote_emails", ["quote_id"])
        apply_org_rls(bind, tables=["quote_emails"])

    if not _has_table(bind, "quote_sms"):
        op.create_table(
            "quote_sms",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("org_id", sa.Integer(), nullable=True),
            sa.Column(
                "quote_id", sa.Integer(),
                sa.ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("recipient_phone", sa.String(length=30), nullable=False),
            sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("delivery_status", sa.String(length=50), nullable=False, server_default="sent"),
            sa.Column("message_sid", sa.String(length=64), nullable=True, unique=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("idx_quote_sms_quote_id", "quote_sms", ["quote_id"])
