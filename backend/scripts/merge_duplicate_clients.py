"""
Merge duplicate Client records that represent the same person.

Two clients are considered the same when they share a normalized email OR the
last 10 digits of a phone number (transitively — A~B and B~C merges A,B,C). For
each group the OLDEST client is kept; every other row's references are repointed
to the keeper and the duplicate is deleted. Grouping is scoped per org_id so
tenants never merge into each other.

Default run is a DRY-RUN — it prints the merge plan and touches nothing. Re-run
with --commit to apply.

    cd backend
    python scripts/merge_duplicate_clients.py           # dry run
    python scripts/merge_duplicate_clients.py --commit  # merge for real

Repointing is schema-generic: every table with a `client_id` column (discovered
via the SQLAlchemy inspector) is updated, so new FK tables are handled
automatically. contact_emails/contact_phones are included, so the keeper inherits
the duplicates' alternate contacts and future lookups still match.
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
from database.models import Client  # noqa: E402
from utils.contacts import phone_last10  # noqa: E402


def client_keys(c):
    """Identity keys for a client, scoped by org so tenants stay separate."""
    org = getattr(c, "org_id", None)
    keys = set()
    if c.email and c.email.strip():
        keys.add((org, "email", c.email.strip().lower()))
    last10 = phone_last10(c.phone)
    if last10:
        keys.add((org, "phone", last10))
    return keys


def find_duplicate_groups(clients):
    """Union-find over shared keys → list of groups (each len >= 2)."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:  # path compression
            parent[x], x = root, parent[x]
        return root

    def union(a, b):
        parent[find(a)] = find(b)

    key_owner = {}
    for c in clients:
        find(c.id)
        for k in client_keys(c):
            if k in key_owner:
                union(c.id, key_owner[k])
            else:
                key_owner[k] = c.id

    groups = defaultdict(list)
    for c in clients:
        groups[find(c.id)].append(c)
    return [g for g in groups.values() if len(g) > 1]


def _fk_tables():
    """Every table (except clients itself) that has a client_id column."""
    insp = inspect(engine)
    out = []
    for t in insp.get_table_names():
        cols = {col["name"] for col in insp.get_columns(t)}
        if "client_id" in cols and t != "clients":
            out.append(t)
    return out


def _age_key(c):
    # Oldest wins: real created_at first, NULLs last, ties broken by id.
    return (c.created_at or datetime.max, c.id)


def main():
    ap = argparse.ArgumentParser(description="Merge duplicate clients (dry-run by default).")
    ap.add_argument("--commit", action="store_true", help="apply the merge (default: dry-run)")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        fk_tables = _fk_tables()
        clients = db.query(Client).all()
        groups = find_duplicate_groups(clients)

        if not groups:
            print("No duplicate clients found. Nothing to do.")
            return

        print(f"Found {len(groups)} duplicate group(s). "
              f"Repointing across {len(fk_tables)} client_id table(s): {', '.join(fk_tables)}\n")

        total_dupes = 0
        for g in groups:
            g.sort(key=_age_key)
            keeper, dupes = g[0], g[1:]
            total_dupes += len(dupes)
            print(f"KEEP  #{keeper.id} {keeper.name!r} <{keeper.email or '—'}> {keeper.phone or '—'}")
            for d in dupes:
                print(f"  merge #{d.id} {d.name!r} <{d.email or '—'}> {d.phone or '—'}  → #{keeper.id}")
                if args.commit:
                    for t in fk_tables:
                        db.execute(
                            text(f"UPDATE {t} SET client_id = :keep WHERE client_id = :dupe"),
                            {"keep": keeper.id, "dupe": d.id},
                        )
                    db.execute(text("DELETE FROM clients WHERE id = :dupe"), {"dupe": d.id})
            print()

        if args.commit:
            db.commit()
            print(f"✅ Merged {total_dupes} duplicate client(s) into {len(groups)} keeper(s).")
        else:
            print(f"DRY RUN — would merge {total_dupes} duplicate(s) into {len(groups)} keeper(s). "
                  f"Re-run with --commit to apply.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
