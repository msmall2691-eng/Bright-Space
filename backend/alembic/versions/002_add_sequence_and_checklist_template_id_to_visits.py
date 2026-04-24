"""Add sequence and checklist_template_id to visits table."""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '002'
down_revision = '001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('visits', sa.Column('sequence', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('visits', sa.Column('checklist_template_id', sa.Integer(), nullable=True))


def downgrade():
    op.drop_column('visits', 'checklist_template_id')
    op.drop_column('visits', 'sequence')
