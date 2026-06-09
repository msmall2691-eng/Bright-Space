#!/usr/bin/env python
"""One-time production schema reconciliation (P0, 2026-06-08).

WHY: prod Postgres was built with Base.metadata.create_all(), so tables/enum
types exist without matching Alembic history (alembic_version=011). The quotes
and lead_intakes tables are missing columns added in 013-022, which is why
quoting 500s. The migration chain itself is structurally broken (see
docs/recover-prod-schema-2026-06-08.sql), so we DON'T run `alembic upgrade head`.
Instead: add the missing columns idempotently, then stamp Alembic to 022.

SAFE + idempotent + re-runnable. It only ever ADDs missing columns; it never
drops or alters existing ones.

  0. GATE: aborts unless quotes.id is integer/bigint. If it's uuid the table
     predates 018_integerize_quotes and needs a real migration, not added columns.
  1. ADD COLUMN IF NOT EXISTS for every Quote/LeadIntake column missing on the
     live DB (types read from the models), all in ONE transaction.
  2. `alembic stamp 022_intake_converted_quote_fk`.

USAGE (in the app container, DATABASE_URL set; BACK UP POSTGRES FIRST):
    python scripts/reconcile_prod_schema.py --dry-run   # read-only: gate + the
                                                        # exact missing columns
    python scripts/reconcile_prod_schema.py             # apply + stamp
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

import sqlalchemy as sa  # noqa: E402
from database.models import Quote, LeadIntake  # noqa: E402

STAMP_REVISION = "022_intake_converted_quote_fk"
TABLES = [(Quote, "quotes"), (LeadIntake, "lead_intakes")]


def _pgtype(col) -> str:
    t = col.type
    if isinstance(t, sa.Float): return "double precision"
    if isinstance(t, (sa.Integer, sa.BigInteger)): return "integer"
    if isinstance(t, sa.Boolean): return "boolean"
    if isinstance(t, sa.Date): return "date"
    if isinstance(t, sa.DateTime): return "timestamptz"
    if isinstance(t, sa.Text): return "text"
    if isinstance(t, sa.JSON): return "jsonb"
    if isinstance(t, sa.String): return f"varchar({t.length})" if t.length else "varchar"
    return "text"


def _target_columns(model):
    return [(c.name, _pgtype(c)) for c in model.__table__.columns if not c.primary_key]


def _existing_columns(conn, table) -> set:
    rows = conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns WHERE table_name=:t"
    ), {"t": table}).scalars().all()
    return set(rows)


def _engine():
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        return None
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return sa.create_engine(url)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="read-only: show the gate + missing columns")
    args = ap.parse_args()

    engine = _engine()
    if engine is None:
        if args.dry_run:
            print("# DATABASE_URL not set — offline plan (full target column set):\n")
            for model, table in TABLES:
                for name, typ in _target_columns(model):
                    print(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "{name}" {typ};')
            return 0
        print("ERROR: DATABASE_URL is not set.", file=sys.stderr)
        return 2

    # --- Read-only inspection (both modes do this) ---------------------------
    with engine.connect() as conn:
        id_type = conn.execute(sa.text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_name='quotes' AND column_name='id'"
        )).scalar()
        print(f"[gate] quotes.id data_type = {id_type!r}")
        if id_type not in ("integer", "bigint"):
            print(
                f"ABORT: quotes.id is {id_type!r}, expected integer/bigint. The table "
                "predates 018_integerize_quotes — added columns won't fix it. Stop and "
                "escalate (needs a type migration).", file=sys.stderr,
            )
            return 3

        try:
            version = conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
        except Exception:
            version = "(no alembic_version row)"
        print(f"[alembic] current version = {version!r}")

        missing = []  # (table, name, type)
        for model, table in TABLES:
            existing = _existing_columns(conn, table)
            for name, typ in _target_columns(model):
                if name not in existing:
                    missing.append((table, name, typ))

    if not missing:
        print("[ok] no missing columns — schema already matches the models.")
    else:
        print(f"[diff] {len(missing)} column(s) missing:")
        for table, name, typ in missing:
            print(f"    {table}.{name}  ({typ})")

    if args.dry_run:
        print(f"\n# DRY RUN — nothing changed. Apply would add the above, then: alembic stamp {STAMP_REVISION}")
        return 0

    # --- Apply: add missing columns in one transaction -----------------------
    if missing:
        with engine.begin() as conn:
            for table, name, typ in missing:
                conn.execute(sa.text(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "{name}" {typ}'))
            try:
                conn.execute(sa.text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ix_quotes_public_token ON quotes (public_token)"
                ))
            except Exception as e:
                print(f"[warn] skipped public_token unique index (legacy dup?): {e}")
        print(f"[apply] added {len(missing)} column(s) in one transaction.")

    # --- Stamp Alembic to reality --------------------------------------------
    print(f"[stamp] alembic stamp {STAMP_REVISION}")
    r = subprocess.run(["alembic", "stamp", STAMP_REVISION], cwd=str(BACKEND_DIR))
    if r.returncode != 0:
        print("ERROR: alembic stamp failed.", file=sys.stderr)
        return 4

    with engine.connect() as conn:
        after = conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
    print(f"[after] alembic_version = {after!r}")
    print("\nDone. Verify /api/health → schema.ok:true, db_revision:022, then test quoting.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
