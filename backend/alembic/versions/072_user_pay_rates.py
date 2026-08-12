"""Per-cleaner pay rate overrides for the native payroll source.

Additive only (R8): two nullable $/hr columns on users. NULL means "use the
global Settings rate", so existing behavior is unchanged and the Connecteam
payroll source ignores them entirely. Read only by the native payroll source
(gated behind the payroll_source flag, default 'connecteam').

Revision ID: 072_user_pay_rates
Revises: 071_time_entry_gps
"""
from alembic import op
import sqlalchemy as sa


revision = "072_user_pay_rates"
down_revision = "071_time_entry_gps"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("pay_rate_residential", sa.Float(), nullable=True))
    op.add_column("users", sa.Column("pay_rate_rental", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "pay_rate_rental")
    op.drop_column("users", "pay_rate_residential")
