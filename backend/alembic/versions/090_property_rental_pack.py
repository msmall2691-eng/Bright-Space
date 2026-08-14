"""Rental pack: property WiFi + crew house notes + reference photos.

Owner ask (Aug 2026): rentals carry the most field knowledge — let crew
post notes the office can promote to everyone, give every property a
reference photo gallery ("how the beds should be made"), and put the
guest WiFi on the job card (and therefore in the crew app's offline
cache — at a dead-zone house the credentials themselves are the fix).

- properties.wifi_ssid / wifi_password (nullable strings).
- property_crew_notes: author + shared flag; office promotes.
- property_photos: bytes-in-DB, same rationale and caps as job_photos
  (migration 081); loaded only when the gallery opens.

Additive (R8). Both new tables in TENANT_TABLES.

Revision ID: 090_property_rental_pack
Revises: 089_crew_requests_notes_messages
"""
from alembic import op
import sqlalchemy as sa


revision = "090_property_rental_pack"
down_revision = "089_crew_requests_notes_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("properties", sa.Column("wifi_ssid", sa.String(length=120), nullable=True))
    op.add_column("properties", sa.Column("wifi_password", sa.String(length=120), nullable=True))
    op.create_table(
        "property_crew_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("property_id", sa.Integer(),
                  sa.ForeignKey("properties.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("author_name", sa.String(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("shared", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_property_crew_notes_org_id", "property_crew_notes", ["org_id"])
    op.create_index("ix_property_crew_notes_property_id", "property_crew_notes", ["property_id"])
    op.create_table(
        "property_photos",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("property_id", sa.Integer(),
                  sa.ForeignKey("properties.id", ondelete="CASCADE"), nullable=False),
        sa.Column("uploaded_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("caption", sa.String(length=200), nullable=True),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_property_photos_org_id", "property_photos", ["org_id"])
    op.create_index("ix_property_photos_property_id", "property_photos", ["property_id"])


def downgrade() -> None:
    op.drop_index("ix_property_photos_property_id", table_name="property_photos")
    op.drop_index("ix_property_photos_org_id", table_name="property_photos")
    op.drop_table("property_photos")
    op.drop_index("ix_property_crew_notes_property_id", table_name="property_crew_notes")
    op.drop_index("ix_property_crew_notes_org_id", table_name="property_crew_notes")
    op.drop_table("property_crew_notes")
    op.drop_column("properties", "wifi_password")
    op.drop_column("properties", "wifi_ssid")
