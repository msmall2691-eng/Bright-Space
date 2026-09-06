"""
The Saturday window: staffing a week of turnovers as one batch.

STR turnovers are not routes. They come from iCal feeds week to week and the
volume swings — twelve on a July Saturday, two in October — so they can't be a
standing block somebody owns. They stay on the posted-job path.

But posting them ONE AT A TIME, each needing its own approval, is the
office-is-the-bottleneck problem again, one row at a time, on the busiest day
of the week. A window posts the whole Saturday at once on a fixed day, lets the
bench take what they want, and RAISES THE PRICE on whatever is still unclaimed
as the date closes in.

The step-up is the part that does the work. A turnover nobody wants at $85 is a
turnover somebody wants at $110, and finding that out on Wednesday is worth a
great deal more than finding it out on Friday night. The alternative — the
office ringing round on Friday — is the thing this exists to stop.

- One window per (org, service_date). The date IS the identity; two windows for
  one Saturday would step the same jobs twice.
- No job columns. A window opens ordinary Jobs for claims and writes
  posted_rate, which is the marketplace path 097 already built and tested. The
  window owns the schedule and the price ladder; it does not own the work.
- steps_taken is stored, not derived from a rate: the office can edit a job's
  posted_rate by hand, and a ladder that re-derived its position from the
  current price would restart or skip depending on which way they nudged it.

Revision ID: 101_turnover_windows
Revises: 100_routes
"""
from alembic import op
import sqlalchemy as sa


revision = "101_turnover_windows"
down_revision = "100_routes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "turnover_windows",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        # The day being staffed. Usually a Saturday; not enforced, because a
        # mid-week changeover is a real thing and refusing it would only teach
        # people to work around this.
        sa.Column("service_date", sa.Date(), nullable=False, index=True),
        # pending | open | closed
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        # What each turnover is first posted at. NULL means "leave each job's
        # own posted_rate alone" — a window can be used purely to open a batch.
        sa.Column("base_rate", sa.Float(), nullable=True),
        # Each step adds this percentage of the BASE rate, not of the current
        # one: compounding turns a 10% ladder into a 61% raise by step five,
        # which is not what anybody typed.
        sa.Column("step_pct", sa.Float(), nullable=False, server_default="10"),
        sa.Column("max_steps", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("steps_taken", sa.Integer(), nullable=False, server_default="0"),
        # Days before service_date that the batch opens, and days before it
        # that the price ladder starts climbing.
        sa.Column("open_days_before", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("first_step_days_before", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("opened_at", sa.DateTime(), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("last_stepped_at", sa.DateTime(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("org_id", "service_date", name="uq_turnover_windows_org_date"),
    )
    op.create_index("ix_turnover_windows_status_date", "turnover_windows",
                    ["status", "service_date"])


def downgrade() -> None:
    op.drop_index("ix_turnover_windows_status_date", table_name="turnover_windows")
    op.drop_table("turnover_windows")
