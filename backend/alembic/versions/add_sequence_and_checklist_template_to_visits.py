"""Add sequence and checklist_template_id to visits table."""
# This migration adds missing columns that are in VisitCreate/VisitRead schemas
# but were not in the Visit ORM model, causing backfill to fail.

from alembic import op
import sqlalchemy as sa


def upgrade():
    # Add sequence column (which occurrence of a recurring job)
    op.add_column('visits', sa.Column('sequence', sa.Integer(), nullable=False, server_default='1'))

    # Add checklist_template_id column (which checklist template was used)
    op.add_column('visits', sa.Column('checklist_template_id', sa.Integer(), nullable=True))


def downgrade():
    op.drop_column('visits', 'checklist_template_id')
    op.drop_column('visits', 'sequence')
