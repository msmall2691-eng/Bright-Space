"""
Routes: a standing block of recurring work owned by one subcontractor.

Migration 097 made one-off work a marketplace (post a rate, subs request,
office approves). That shape is wrong for recurring work, which is most of the
book: nobody wants to re-bid the same Tuesday house every week, the office
doesn't want to re-approve it every week, and a sub can't plan a business out
of jobs that might not arrive.

A route is the recurring counterpart: a named grouping of RecurringSchedule
rows, owned by one cleaner at one rate, with a named backup.

- routes.rate is priced per occurrence of the WHOLE block, because that is how
  a sub thinks about it ("$400 for my Tuesday"). Generation distributes it
  across the jobs that occurrence produced and writes each share to
  Job.agreed_rate — the flat-rate path payroll already pays (migration 097).
  No payroll, invoicing or marketplace change is needed as a result.
- route_members.recurring_schedule_id is UNIQUE on purpose: a schedule in two
  routes means two people are paid for one house.

Both tables carry org_id and are added to TENANT_TABLES in the same change —
migration 095 exists because two tables sat org-scoped but unprotected for
months, and 097 kept the streak.

Revision ID: 100_routes
Revises: 099_sub_payouts
"""
from alembic import op
import sqlalchemy as sa


revision = "100_routes"
down_revision = "099_sub_payouts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "routes",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("name", sa.String(), nullable=False),
        # Display/grouping only — the member schedules carry the real cadence.
        sa.Column("day_of_week", sa.Integer(), nullable=False),
        # Same crew-ID string space as Job.cleaner_ids / User.cleaner_id.
        sa.Column("owner_cleaner_id", sa.String(), nullable=True, index=True),
        sa.Column("backup_cleaner_id", sa.String(), nullable=True),
        sa.Column("rate", sa.Float(), nullable=True),
        # draft | offered | active | ended
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("offered_at", sa.DateTime(), nullable=True),
        sa.Column("accepted_at", sa.DateTime(), nullable=True),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_routes_org_status", "routes", ["org_id", "status"])

    op.create_table(
        "route_members",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("route_id", sa.Integer(), sa.ForeignKey("routes.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("recurring_schedule_id", sa.Integer(),
                  sa.ForeignKey("recurring_schedules.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        # Drive order within the day.
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        # One house, one route, one person paid for it.
        sa.UniqueConstraint("recurring_schedule_id", name="uq_route_members_schedule"),
    )


def downgrade() -> None:
    op.drop_table("route_members")
    op.drop_index("ix_routes_org_status", table_name="routes")
    op.drop_table("routes")
