"""Job photos: before/after shots the crew attaches from My Day.

New table `job_photos` — photo bytes live in the DATABASE (BYTEA on Postgres),
not on disk: Railway's container filesystem is ephemeral, so a deploy would
delete anything written there, and no object store is configured. The client
downscales before upload and the endpoint caps size (5MB) and count (30/job),
so rows stay modest and photos ride along with normal DB backups.

Deliberately NOT the existing Job.photos JSON column: that blob sits on the
bulk-fetched jobs table (Schedule / My Day / dashboards would drag every byte
on every list query). Job.photos stays as-is for the legacy office-modal
entries; new photos land here.

org_id makes this a tenant table — paired with the TENANT_TABLES entry in
database/rls.py (the RLS backstop picks it up from there).

Revision ID: 081_job_photos
Revises: 080_job_completion_note
"""
from alembic import op
import sqlalchemy as sa


revision = "081_job_photos"
down_revision = "080_job_completion_note"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "job_photos",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("job_id", sa.Integer(),
                  sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("uploaded_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.String(length=8), nullable=True),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_job_photos_org_id", "job_photos", ["org_id"])
    op.create_index("ix_job_photos_job_id", "job_photos", ["job_id"])


def downgrade() -> None:
    # Drops the photos with it — acceptable: this table exists only for this
    # feature, and rolling the feature back means giving the photos up.
    op.drop_index("ix_job_photos_job_id", table_name="job_photos")
    op.drop_index("ix_job_photos_org_id", table_name="job_photos")
    op.drop_table("job_photos")
