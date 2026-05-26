"""011 — add checklist_template to properties.

Revision ID: 011
"""
from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("properties", sa.Column("checklist_template", sa.JSON, nullable=True))


def downgrade():
    op.drop_column("properties", "checklist_template")
