"""
Alembic migration: Phase 0 performance indexes
Alembic version: 032

Adds the two indexes the hot list endpoints filter/sort on but were missing:
  - clients.status            — GET /api/clients?status=active (dashboard, lists)
  - lead_intakes(status, created_at) — GET /api/intake (Requests list, dashboard)

Jobs and visits are already covered by composite indexes (idx_job_*, idx_visit_*),
and most other filter columns already carry index=True, so this migration is
deliberately small — only the genuinely-missing indexes.
"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "032_perf_indexes"
down_revision = "031_quote_sms_tracking"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # if_not_exists guards against environments where the index was already
    # created out-of-band (or by create_all on a fresh DB).
    op.create_index(
        "ix_clients_status", "clients", ["status"], if_not_exists=True,
    )
    op.create_index(
        "idx_intake_status_created", "lead_intakes", ["status", "created_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("idx_intake_status_created", table_name="lead_intakes", if_exists=True)
    op.drop_index("ix_clients_status", table_name="clients", if_exists=True)
