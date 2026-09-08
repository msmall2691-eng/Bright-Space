"""Make portal magic links single-use (BB-SEC-21).

A customer-portal magic link is a bearer JWT valid for 30 minutes, and nothing
stopped it being redeemed more than once in that window — so a link that leaked
(forwarded mail, a shared inbox, proxy or browser history, a Referer header)
could be replayed into fresh 14-day sessions until it expired, while the email
that carried it promised it "can only be used once".

This adds `used_portal_magic_links`, the ledger that makes that promise true:
the app records a link's id (its `jti`, or a hash of the token for links issued
before the jti shipped) the first time it is redeemed, and the primary key makes
that first redemption atomic — a second redemption of the same link trips the
unique violation and is refused.

Additive and reversible. NOT a tenant table: it holds no customer record, only
an opaque token id and two timestamps, so it carries no `org_id`, is not in
TENANT_TABLES, and takes no RLS policy — it is an auth nonce ledger, the same
shape as a token denylist. The downgrade drops it cleanly (the only thing lost
is in-flight single-use state for links still inside their 30-minute window).

Revision ID: 112_portal_magic_single_use
Revises: 111_claim_request_reason
"""
import sqlalchemy as sa
from alembic import op

revision = "112_portal_magic_single_use"
down_revision = "111_claim_request_reason"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "used_portal_magic_links",
        sa.Column("jti", sa.String(), primary_key=True, nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_used_portal_magic_links_expires_at",
        "used_portal_magic_links", ["expires_at"],
    )


def downgrade():
    op.drop_index("ix_used_portal_magic_links_expires_at",
                  table_name="used_portal_magic_links")
    op.drop_table("used_portal_magic_links")
