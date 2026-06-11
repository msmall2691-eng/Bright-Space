#!/usr/bin/env python
"""Production schema reconciliation (P0, 2026-06-08; extended 2026-06-10).

WHY: prod Postgres was built with Base.metadata.create_all(), so tables/enum
types exist without matching Alembic history (alembic_version=011), and the
migration chain itself is structurally broken (see
docs/recover-prod-schema-2026-06-08.sql), so we DON'T run `alembic upgrade head`.
Originally this reconciled only the quote tables (missing columns from 013-022
made quoting 500). On 2026-06-10 properties.custom_fields turned up missing in
prod too (/api/visits 500, UndefinedColumn), proving the drift isn't confined
to quoting — so this now diffs EVERY model table against the live schema.

SAFE + idempotent + re-runnable. It only ADDs missing tables/columns/FK; it
never drops or alters existing objects.

  0. GATE: aborts unless quotes.id is integer/bigint. If it's uuid the table
     predates 018_integerize_quotes and needs a real migration, not this.
  1. CREATE any missing model TABLE (everything registered on Base.metadata)
     — checkfirst, so existing tables are untouched.
  2. ADD COLUMN IF NOT EXISTS for every model column missing on an existing table.
  3. ADD the lead_intakes.converted_quote_id -> quotes(id) FK (the thing 022 adds),
     idempotently.
  All of 1-3 in ONE transaction.
  4. `alembic stamp 022_intake_converted_quote_fk`.

USAGE (in the app container, DATABASE_URL set; BACK UP POSTGRES FIRST):
    python scripts/reconcile_prod_schema.py --dry-run   # read-only: gate + full diff
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
from database.base import Base  # noqa: E402
import database.models  # noqa: E402,F401  (import registers every model on Base.metadata)

STAMP_REVISION = "022_intake_converted_quote_fk"
# Every model table, in FK-dependency order so creation works. quotes /
# lead_intakes / jobs / ical_events have mutually dependent FKs, so SQLAlchemy
# can't order within that cycle and warns; those are core tables that always
# exist in prod, so creation order for them never actually matters here.
import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", sa.exc.SAWarning)
    TABLES = list(Base.metadata.sorted_tables)
FK_NAME = "fk_lead_intakes_converted_quote_id"


def _pgtype(col) -> str:
    t = col.type
    if isinstance(t, sa.Float): return "double precision"
    if isinstance(t, sa.BigInteger): return "bigint"
    if isinstance(t, sa.Integer): return "integer"
    if isinstance(t, sa.Boolean): return "boolean"
    if isinstance(t, sa.DateTime): return "timestamptz"
    if isinstance(t, sa.Date): return "date"
    if isinstance(t, sa.Time): return "time"
    if isinstance(t, sa.Text): return "text"
    if isinstance(t, sa.JSON): return "jsonb"
    if isinstance(t, sa.String): return f"varchar({t.length})" if t.length else "varchar"
    return "text"


def _target_columns(table):
    return [(c.name, _pgtype(c)) for c in table.columns if not c.primary_key]


def _table_exists(conn, table) -> bool:
    return bool(conn.execute(sa.text(
        "SELECT 1 FROM information_schema.tables WHERE table_name=:t"
    ), {"t": table}).scalar())


def _existing_columns(conn, table) -> set:
    return set(conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns WHERE table_name=:t"
    ), {"t": table}).scalars().all())


def _fk_exists(conn, name) -> bool:
    return bool(conn.execute(sa.text(
        "SELECT 1 FROM information_schema.table_constraints "
        "WHERE constraint_name=:n AND constraint_type='FOREIGN KEY'"
    ), {"n": name}).scalar())


def _engine():
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        return None
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return sa.create_engine(url)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="read-only: gate + the full diff")
    args = ap.parse_args()

    engine = _engine()
    if engine is None:
        if args.dry_run:
            print("# DATABASE_URL not set — can't inspect; showing target tables only:")
            for table in TABLES:
                print(f"  ensure table: {table.name}")
            print(f"  ensure FK: {FK_NAME} (lead_intakes.converted_quote_id -> quotes.id)")
            return 0
        print("ERROR: DATABASE_URL is not set.", file=sys.stderr)
        return 2

    with engine.connect() as conn:
        id_type = conn.execute(sa.text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_name='quotes' AND column_name='id'"
        )).scalar()
        print(f"[gate] quotes.id data_type = {id_type!r}")
        if id_type not in ("integer", "bigint"):
            print(f"ABORT: quotes.id is {id_type!r}, expected integer/bigint — the table "
                  "predates 018_integerize_quotes and needs a type migration, not this.",
                  file=sys.stderr)
            return 3
        try:
            version = conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
        except Exception:
            conn.rollback()  # a failed SELECT aborts the pg transaction; reset it
            version = "(none)"
        print(f"[alembic] current version = {version!r}")

        missing_tables, missing_cols = [], []
        for table in TABLES:
            if not _table_exists(conn, table.name):
                missing_tables.append(table.name)
                continue
            existing = _existing_columns(conn, table.name)
            for name, typ in _target_columns(table):
                if name not in existing:
                    missing_cols.append((table.name, name, typ))
        fk_missing = not _fk_exists(conn, FK_NAME)

    print(f"[diff] missing tables: {missing_tables or 'none'}")
    print(f"[diff] missing columns: {len(missing_cols)}")
    for table, name, typ in missing_cols:
        print(f"    {table}.{name}  ({typ})")
    print(f"[diff] converted_quote_id FK ({FK_NAME}) missing: {fk_missing}")

    if args.dry_run:
        print(f"\n# DRY RUN — nothing changed. Apply would create the tables above, add the "
              f"columns, add the FK, then: alembic stamp {STAMP_REVISION}")
        return 0

    with engine.begin() as conn:
        # 1) create any missing tables straight from the model (checkfirst skips existing).
        for table in TABLES:
            if table.name in missing_tables:
                table.create(bind=conn, checkfirst=True)
                print(f"[apply] created table {table.name}")
        # 2) add missing columns on tables that already existed.
        for table, name, typ in missing_cols:
            conn.execute(sa.text(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "{name}" {typ}'))
        if missing_cols:
            print(f"[apply] added {len(missing_cols)} column(s)")
        # 3) the FK that 022 adds (idempotent via a duplicate_object guard).
        conn.execute(sa.text(
            f"DO $$ BEGIN "
            f"ALTER TABLE lead_intakes ADD CONSTRAINT {FK_NAME} "
            f"FOREIGN KEY (converted_quote_id) REFERENCES quotes(id) ON DELETE SET NULL; "
            f"EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;"
        ))
        try:
            conn.execute(sa.text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_quotes_public_token ON quotes (public_token)"
            ))
        except Exception as e:
            print(f"[warn] skipped public_token unique index (legacy dup?): {e}")
    print("[apply] schema reconciled in one transaction.")

    print(f"[stamp] alembic stamp {STAMP_REVISION}")
    # NOTE: must be the console script, not `python -m alembic` — with
    # cwd=backend the alembic/ migrations dir shadows the real package.
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
