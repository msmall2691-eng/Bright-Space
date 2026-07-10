"""
One-time cleanup for duplicate STR turnover jobs left by the cancel<->recreate
sync bug (see integrations/ical_sync.py's sync_property for the fix, and
alembic migration 052 for the DB-level backstop this script's cleanup exists
alongside).

Scope: only `jobs` rows with job_type='str_turnover' AND status='cancelled'
grouped by (property_id, scheduled_date). Non-cancelled duplicates are NOT
this script's job — those were already collapsed automatically by migration
052's upgrade() (soft-cancelled, never deleted) so the new partial unique
index could be created safely. This script is for the mass of already-
cancelled junk rows the bug produced (hundreds of copies of one booking in
the reported case), which are harmless but clutter the data.

For each duplicate group, the KEEPER is whichever row an ICalEvent still
points at (if any), else the most-recently-updated row; every other row is a
candidate for deletion. A candidate is only actually deleted if it has NO
rows in any other table with a job_id column (Invoice, Activity, Message,
etc., discovered dynamically) — a duplicate that already picked up real
history is left alone and reported, never silently deleted.

Default run is a DRY-RUN — it prints the cleanup plan and touches nothing.
Re-run with --commit to apply.

    cd backend
    python scripts/cleanup_ical_turnover_duplicates.py                       # dry run, all properties
    python scripts/cleanup_ical_turnover_duplicates.py --property-id 13      # dry run, one property
    python scripts/cleanup_ical_turnover_duplicates.py --commit              # delete for real
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import inspect, text  # noqa: E402

from database.db import SessionLocal, engine  # noqa: E402
from database.models import Job, ICalEvent  # noqa: E402


def _fk_tables():
    """Every table (except jobs itself) that has a job_id column — a
    duplicate row with children in any of these is real history, not junk."""
    insp = inspect(engine)
    out = []
    for t in insp.get_table_names():
        cols = {col["name"] for col in insp.get_columns(t)}
        if "job_id" in cols and t != "jobs":
            out.append(t)
    return out


def _has_children(db, fk_tables, job_id):
    for t in fk_tables:
        n = db.execute(
            text(f"SELECT count(*) FROM {t} WHERE job_id = :jid"), {"jid": job_id}
        ).scalar()
        if n:
            return t, n
    return None, 0


def main():
    ap = argparse.ArgumentParser(
        description="Purge excess cancelled-duplicate STR turnover jobs (dry-run by default).")
    ap.add_argument("--commit", action="store_true", help="apply the deletes (default: dry-run)")
    ap.add_argument("--property-id", type=int, default=None, help="limit to one property")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        fk_tables = _fk_tables()
        q = db.query(Job).filter(Job.job_type == "str_turnover", Job.status == "cancelled")
        if args.property_id is not None:
            q = q.filter(Job.property_id == args.property_id)
        jobs = q.all()

        groups = defaultdict(list)
        for j in jobs:
            groups[(j.property_id, j.scheduled_date)].append(j)
        groups = {k: v for k, v in groups.items() if len(v) > 1}

        if not groups:
            print("No duplicate cancelled turnovers found. Nothing to do.")
            return

        # ICalEvent.job_id is unique, so at most one event points at any given
        # job — build the reverse map once instead of a query per candidate.
        linked_job_ids = {
            row[0] for row in db.query(ICalEvent.job_id).filter(ICalEvent.job_id.isnot(None)).all()
        }

        print(f"Found {len(groups)} duplicate group(s) across "
              f"{'property ' + str(args.property_id) if args.property_id else 'all properties'}. "
              f"Checking history in: {', '.join(fk_tables) or '(none found)'}\n")

        total_deleted = 0
        total_skipped = 0
        for (property_id, scheduled_date), rows in sorted(groups.items(), key=lambda kv: (kv[0][0], str(kv[0][1]))):
            rows.sort(key=lambda j: (j.id in linked_job_ids, j.updated_at or j.created_at, j.id), reverse=True)
            keeper, dupes = rows[0], rows[1:]
            print(f"property={property_id} date={scheduled_date}: "
                  f"{len(rows)} cancelled copies — KEEP #{keeper.id}"
                  f"{' (linked to an ICalEvent)' if keeper.id in linked_job_ids else ''}")
            for d in dupes:
                table, n = _has_children(db, fk_tables, d.id)
                if table:
                    print(f"  SKIP #{d.id} — has {n} row(s) in {table}, not junk, left alone")
                    total_skipped += 1
                    continue
                print(f"  delete #{d.id}")
                total_deleted += 1
                if args.commit:
                    db.execute(text("DELETE FROM jobs WHERE id = :id"), {"id": d.id})
            print()

        if args.commit:
            db.commit()
            print(f"✅ Deleted {total_deleted} duplicate cancelled turnover(s) "
                  f"({total_skipped} skipped — had real history).")
        else:
            print(f"DRY RUN — would delete {total_deleted} duplicate(s), "
                  f"skip {total_skipped} (had real history). Re-run with --commit to apply.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
