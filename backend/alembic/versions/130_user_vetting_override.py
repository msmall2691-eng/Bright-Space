"""Per-cleaner admin vetting override on users.

The owner's "get them working now, collect the docs later" call: a specific
cleaner can take work while their file is still incomplete, when an admin says
so. Mirrors the grandfather exemption (sub_vetting.exempt_against) but
per-person and admin-granted — it clears the OFFICE-approved path
(blocking_requirements) while the file's honest answer (can_take_jobs) stays
False, so instant auto-award stays fail-closed and the bench always shows the
gap. Holds until an admin clears it or the real documents land.

Four additive columns on `users`, no data change, no behavior change until the
new code reads them (scheduling-invariants doesn't apply — this is vetting, not
schedule state; additive only regardless):
  - vetting_override        bool, NOT NULL, server_default 0 (off for everyone)
  - vetting_override_by     int, who granted it (audit; app-enforced, not a FK)
  - vetting_override_at     when
  - vetting_override_reason free-text note

Reversible: downgrade drops the four columns (the values go with them — nobody
is overridden before this ships, so there is nothing to lose).

Revision ID: 130_user_vetting_override
Revises: 129_backfill_null_org_tenant_rows
"""
import sqlalchemy as sa
from alembic import op

revision = "130_user_vetting_override"
down_revision = "129_backfill_null_org_tenant_rows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A NOT NULL boolean added to an existing table needs a server_default so the
    # existing rows fill in (same pattern as migrations 122 / 126).
    op.add_column("users", sa.Column(
        "vetting_override", sa.Boolean(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("vetting_override_by", sa.Integer(), nullable=True))
    op.add_column("users", sa.Column("vetting_override_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("vetting_override_reason", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.drop_column("vetting_override_reason")
        b.drop_column("vetting_override_at")
        b.drop_column("vetting_override_by")
        b.drop_column("vetting_override")
