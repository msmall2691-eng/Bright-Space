"""
Merge duplicate Property records that represent the same physical address.

Two properties are duplicates when they belong to the SAME client and share a
normalized (street, city, state, zip) key — matching how the app dedups on write
(modules.intake.normalize._property_key). Grouping is scoped per client, so two
different clients at the same street address never merge, and a client whose two
real properties are "123 Main St, Portland" and "123 Main St, Bath" stay
separate (the key includes city/state/zip, not just the street line).

For each group the OLDEST property is kept; every other row's references are
repointed to the keeper and the duplicate is deleted. The keeper also inherits
any size fields (bedrooms/bathrooms/square_footage) it was missing but a
duplicate had, so no captured detail is lost in the merge.

Default run is a DRY-RUN — it prints the merge plan and touches nothing. Re-run
with --commit to apply.

    cd backend
    python scripts/merge_duplicate_properties.py           # dry run
    python scripts/merge_duplicate_properties.py --commit  # merge for real

Repointing is schema-generic: every table with a `property_id` column
(discovered via the SQLAlchemy inspector) is updated — jobs, quotes,
lead_intakes, recurring_schedules, property_icals, ical_events, and any future
FK table — so new references are handled automatically.

Each group merges inside its own SAVEPOINT. If two duplicate properties both
have dependent rows protected by a per-property unique key (e.g. STR
`ical_events` sharing a `(property_id, uid)`, or turnover jobs sharing a
`(property_id, scheduled_date, job_type)`), the repoint would collide; that
group is rolled back and reported for manual review instead of aborting the
whole run. Redundant `ical_events` (re-syncable) are coalesced automatically
before the repoint so the common STR case merges cleanly.
"""

import argparse
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import inspect, text  # noqa: E402

from database.db import SessionLocal, engine  # noqa: E402
from database.models import Property  # noqa: E402
from modules.intake.normalize import _property_key  # noqa: E402


def property_key(p):
    """(client_id, normalized address tuple) — the per-client dedup identity.

    A property with no address can't be safely matched to another, so it never
    groups (returns a unique key on its own id)."""
    if not (p.address or "").strip():
        return ("no-address", p.id)
    return (p.client_id, _property_key(p.address, p.city, p.state, p.zip_code))


def find_duplicate_groups(properties):
    """Group properties by their per-client address key → list of groups
    (each len >= 2)."""
    groups = defaultdict(list)
    for p in properties:
        groups[property_key(p)].append(p)
    return [g for g in groups.values() if len(g) > 1]


def _fk_tables():
    """Every table (except properties itself) that has a property_id column."""
    insp = inspect(engine)
    out = []
    for t in insp.get_table_names():
        cols = {col["name"] for col in insp.get_columns(t)}
        if "property_id" in cols and t != "properties":
            out.append(t)
    return out


def _age_key(p):
    # Oldest wins: real created_at first, NULLs last, ties broken by id.
    return (p.created_at or datetime.max, p.id)


# Size fields the keeper inherits from a duplicate when the keeper is missing them.
_BACKFILL_FIELDS = ("bedrooms", "bathrooms", "square_footage")


def _coalesce_ical_events(db, keeper_id, dupe_id):
    """Drop the duplicate property's ical_events whose uid already exists on the
    keeper BEFORE repointing, so the repoint can't violate the per-property
    (property_id, uid) uniqueness (migration 052). iCal events are re-synced
    from the feed on the next tick, so removing the redundant copies is safe."""
    db.execute(
        text(
            "DELETE FROM ical_events WHERE property_id = :dupe "
            "AND uid IN (SELECT uid FROM ical_events WHERE property_id = :keep)"
        ),
        {"keep": keeper_id, "dupe": dupe_id},
    )


def _merge_group(db, keeper, dupes, fk_tables, has_ical_events):
    """Repoint + delete one group's duplicates. Runs inside a SAVEPOINT so a
    dependent-row unique collision (e.g. two duplicate STR properties whose
    synced bookings/jobs share a per-property key) rolls back just this group
    and is reported for manual review — instead of aborting the whole --commit.
    Returns None on success or a short error string when the group was skipped."""
    sp = db.begin_nested()
    try:
        for d in dupes:
            # Inherit any size detail the keeper is missing.
            for f in _BACKFILL_FIELDS:
                if not getattr(keeper, f, None) and getattr(d, f, None):
                    setattr(keeper, f, getattr(d, f))
            if has_ical_events:
                _coalesce_ical_events(db, keeper.id, d.id)
            for t in fk_tables:
                db.execute(
                    text(f"UPDATE {t} SET property_id = :keep WHERE property_id = :dupe"),
                    {"keep": keeper.id, "dupe": d.id},
                )
            db.execute(text("DELETE FROM properties WHERE id = :dupe"), {"dupe": d.id})
        sp.commit()
        return None
    except Exception as e:  # noqa: BLE001 — report + skip, don't abort the run
        sp.rollback()
        msg = (str(e).splitlines() or [repr(e)])[0]
        return f"{type(e).__name__}: {msg}"


def main():
    ap = argparse.ArgumentParser(description="Merge duplicate properties (dry-run by default).")
    ap.add_argument("--commit", action="store_true", help="apply the merge (default: dry-run)")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        fk_tables = _fk_tables()
        properties = db.query(Property).all()
        groups = find_duplicate_groups(properties)

        if not groups:
            print("No duplicate properties found. Nothing to do.")
            return

        print(f"Found {len(groups)} duplicate group(s). "
              f"Repointing across {len(fk_tables)} property_id table(s): {', '.join(fk_tables)}\n")

        has_ical_events = "ical_events" in fk_tables
        total_dupes = 0
        merged_groups = 0
        skipped = []  # (keeper_id, error) for groups left for manual review
        for g in groups:
            g.sort(key=_age_key)
            keeper, dupes = g[0], g[1:]
            print(f"KEEP  #{keeper.id} client={keeper.client_id} {keeper.address!r} "
                  f"({keeper.city or '—'}, {keeper.state or '—'} {keeper.zip_code or '—'})")
            for d in dupes:
                print(f"  merge #{d.id} {d.address!r}  → #{keeper.id}")

            if args.commit:
                err = _merge_group(db, keeper, dupes, fk_tables, has_ical_events)
                if err is None:
                    total_dupes += len(dupes)
                    merged_groups += 1
                else:
                    skipped.append((keeper.id, err))
                    print(f"  ⚠ skipped (dependent-row conflict) — left for manual review: {err}")
            else:
                total_dupes += len(dupes)
            print()

        if args.commit:
            db.commit()
            print(f"✅ Merged {total_dupes} duplicate propert(y/ies) into {merged_groups} keeper(s).")
            if skipped:
                print(f"\n⚠ Skipped {len(skipped)} group(s) whose duplicates share a per-property "
                      f"unique key on synced bookings/jobs — merge these manually:")
                for kid, err in skipped:
                    print(f"    keeper #{kid}: {err}")
        else:
            print(f"DRY RUN — would merge {total_dupes} duplicate(s) into {len(groups)} keeper(s). "
                  f"Re-run with --commit to apply.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
