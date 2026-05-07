"""CHECK constraints on Job.status, Job.job_type, Visit.status.

Mirror of migration 006 (which added the same kind of constraint to
properties.property_type). Catches typos at the DB level — the columns
are free strings today; a stray 'completedd' or 'str' (not 'str_turnover')
writes silently and breaks downstream queries.

Constraints:
- jobs.job_type IN ('residential', 'commercial', 'str_turnover')
- jobs.status   IN ('scheduled', 'in_progress', 'completed', 'cancelled')
- visits.status IN ('scheduled', 'dispatched', 'en_route', 'in_progress',
                    'completed', 'no_show', 'cancelled')

Each step normalizes any pre-existing out-of-range values to the safest
default before adding the constraint, so the migration applies cleanly
even if some legacy row has a typo.
"""
from alembic import op
from sqlalchemy import text

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def _normalize_and_constrain(bind, table: str, column: str, allowed: list[str], default: str) -> str:
    """Defensively normalize any out-of-range value in `column` to `default`,
    then add a named CHECK constraint. Returns the constraint name."""
    constraint = f"ck_{table}_{column}"
    quoted = ", ".join(f"'{v}'" for v in allowed)
    bad = bind.execute(
        text(f"SELECT id, {column} FROM {table} "
             f"WHERE {column} IS NULL OR {column} NOT IN ({quoted})")
    ).fetchall()
    for row in bad:
        print(f"[008] Normalizing {table} id={row[0]} {column}={row[1]!r} -> {default!r}")
    if bad:
        bind.execute(
            text(f"UPDATE {table} SET {column} = :d "
                 f"WHERE {column} IS NULL OR {column} NOT IN ({quoted})"),
            {"d": default},
        )
    op.create_check_constraint(
        constraint, table, f"{column} IN ({quoted})"
    )
    return constraint


def upgrade():
    bind = op.get_bind()

    _normalize_and_constrain(
        bind, "jobs", "job_type",
        ["residential", "commercial", "str_turnover"],
        default="residential",
    )
    _normalize_and_constrain(
        bind, "jobs", "status",
        ["scheduled", "in_progress", "completed", "cancelled"],
        default="scheduled",
    )
    _normalize_and_constrain(
        bind, "visits", "status",
        ["scheduled", "dispatched", "en_route", "in_progress",
         "completed", "no_show", "cancelled"],
        default="scheduled",
    )


def downgrade():
    op.drop_constraint("ck_visits_status", "visits", type_="check")
    op.drop_constraint("ck_jobs_status", "jobs", type_="check")
    op.drop_constraint("ck_jobs_job_type", "jobs", type_="check")
