"""
Alembic migration: add connecteam_push_runs table

Companion to making POST /settings/connecteam/push-open-shifts asynchronous
(T-20 Part B). The endpoint previously ran the whole bulk Connecteam POST
inline, blocking the request (and, on a single-worker deploy, every other
request) for the full round trip — observed hanging the UI 3+ minutes with
no progress feedback during the July 2026 audit.

The POST now creates a row here and hands the sweep to a background task,
returning immediately with the run id; a new GET endpoint polls this table
for status. A DB table (not an in-process dict) is required because the app
runs multiple uvicorn workers — the POST and the polling GET can land on
different worker processes.

Alembic version: 054
"""
from alembic import op
import sqlalchemy as sa


revision = "054_connecteam_push_runs"
down_revision = "053_add_unscheduled_to_job_status_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "connecteam_push_runs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("status", sa.String(), nullable=False, server_default="queued"),
        sa.Column("range_start", sa.Date(), nullable=True),
        sa.Column("range_end", sa.Date(), nullable=True),
        sa.Column("considered", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("pushed", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("skipped", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("errors", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "idx_connecteam_push_runs_created_at", "connecteam_push_runs", ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_connecteam_push_runs_created_at", table_name="connecteam_push_runs", if_exists=True)
    op.drop_table("connecteam_push_runs")
