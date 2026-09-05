"""
The vetting file: what a subcontractor has on record before they can work.

Nothing about a sub is recorded today beyond a login, a crew ID and a pay
rate — no W-9, no insurance, no licence, no signed agreement — and there is no
attachment table for a PERSON at all (the only binary storage is JobPhoto and
PropertyPhoto, both hung off a job or a property). Every later phase depends
on this: a sub cannot legally or safely work before it exists.

- sub_documents: one row per document per person. Bytes live in the database,
  the same deliberate choice JobPhoto makes and for the same reason — Railway's
  container disk is ephemeral, so a file on it is a file you lose on the next
  deploy.
- sub_agreements: the written contract, versioned, one row per acceptance and
  never updated. A written agreement defining the relationship is one of the
  named worker-classification criteria, and it is the cheapest of them to
  satisfy — so it gets a real table rather than a boolean.

NOT HERE, DELIBERATELY: any field that could hold an SSN or TIN. A
sole-proprietor W-9 carries one; the returned document is stored as bytes and
never parsed, and an EIN (a business number, not a personal one) is the only
identifier with a column.

`can_take_jobs` is DERIVED from these rows, not stored — see
services/sub_vetting.py. A cached boolean would be wrong the day a COI expires,
which is exactly the day it matters.

Revision ID: 098_sub_documents
Revises: 097_job_claim_requests
"""
from alembic import op
import sqlalchemy as sa


revision = "098_sub_documents"
down_revision = "097_job_claim_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sub_documents",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        # w9 | coi | license | agreement | id
        sa.Column("kind", sa.String(16), nullable=False, index=True),
        # missing | pending | accepted | expired
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        # Only a COI really expires, but a licence can too — nullable so the
        # kinds that don't aren't forced to invent a date.
        sa.Column("expires_at", sa.Date(), nullable=True),
        sa.Column("filename", sa.String(255), nullable=True),
        sa.Column("content_type", sa.String(64), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("data", sa.LargeBinary(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("uploaded_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        # One current row per (person, kind): re-uploading a COI replaces the
        # one on file rather than leaving the office to guess which of three is
        # the live one.
        sa.UniqueConstraint("user_id", "kind", name="uq_sub_documents_user_kind"),
    )

    op.create_table(
        "sub_agreements",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("accepted_at", sa.DateTime(), nullable=False),
        sa.Column("accepted_ip", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_sub_agreements_user_version", "sub_agreements",
                    ["user_id", "version"])


def downgrade() -> None:
    op.drop_index("ix_sub_agreements_user_version", table_name="sub_agreements")
    op.drop_table("sub_agreements")
    op.drop_table("sub_documents")
