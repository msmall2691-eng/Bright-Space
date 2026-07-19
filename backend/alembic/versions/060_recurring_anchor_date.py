"""
Alembic migration: anchor_date on recurring_schedules

Fixes the "biweekly quietly becomes weekly" bug. generate_dates() phased the
on-week/off-week cadence off business_today(), which advances every day, so the
daily generation tick re-seated the phase and materialized the off-week dates a
biweekly rule was meant to skip. Over time every off-week filled in and the
series ran weekly (and the schedule flagged phantom "duplicate/orphaned"
occurrences).

anchor_date is a fixed phase reference — the series' first intended occurrence.
generate_dates()/_nth_occurrence_date() now compute the week parity relative to
this anchor instead of today, so the cadence is stable no matter when the tick
runs.

Backfill (DB-agnostic, done in Python so it works on both Postgres in prod and
SQLite in tests): for each existing schedule pick the most reliable stable
anchor available —
  1. series_start_date  (a split already recorded the intended start), else
  2. MIN(jobs.scheduled_date) for the series (the earliest materialized visit
     is always a correctly-phased occurrence — the bug only ADDS later
     off-week dates, never an earlier one), else
  3. created_at's date (brand-new series with no jobs yet).

This is additive and non-destructive: it only adds a nullable column and fills
it in. No existing rows are deleted or re-dated. (Already-materialized off-week
jobs from before the fix are left in place — stopping new ones is the fix;
cleaning up historical extras is a separate, reviewable data task.)

Alembic version: 060
"""

from alembic import op
import sqlalchemy as sa


revision = "060_recurring_anchor_date"
down_revision = "059_property_turnover_rate"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "recurring_schedules",
        sa.Column("anchor_date", sa.Date(), nullable=True),
    )

    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, series_start_date, created_at "
            "FROM recurring_schedules WHERE anchor_date IS NULL"
        )
    ).fetchall()

    for row in rows:
        sched_id, series_start, created_at = row[0], row[1], row[2]
        anchor = series_start
        if anchor is None:
            anchor = bind.execute(
                sa.text(
                    "SELECT MIN(scheduled_date) FROM jobs "
                    "WHERE recurring_schedule_id = :sid AND scheduled_date IS NOT NULL"
                ),
                {"sid": sched_id},
            ).scalar()
        if anchor is None:
            anchor = created_at
        if anchor is None:
            continue
        # Normalize date | datetime | ISO-ish string down to YYYY-MM-DD. A bare
        # string is accepted by a Date column on both Postgres (implicit cast)
        # and SQLite (typeless text affinity).
        anchor_iso = str(anchor)[:10]
        bind.execute(
            sa.text("UPDATE recurring_schedules SET anchor_date = :a WHERE id = :sid"),
            {"a": anchor_iso, "sid": sched_id},
        )


def downgrade() -> None:
    op.drop_column("recurring_schedules", "anchor_date")
