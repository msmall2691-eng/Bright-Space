"""
One-time fix: promote an existing user to admin.

Context: `_resolve_google_user` (modules/auth/router.py) grants the "admin"
role to whichever auto-approved signup is FIRST to join a workspace with no
active admin yet — every signup after that lands as "member", regardless of
who's actually meant to own the account. If nobody in a workspace currently
holds "admin" (confirmed via Settings -> Users in the app), this script is
the one-time fix: promote a specific user by email directly.

Default run is a DRY-RUN — it prints what WOULD change and touches nothing.
Re-run with --commit to apply.

    cd backend
    python scripts/promote_to_admin.py --email owner@example.com            # dry run
    python scripts/promote_to_admin.py --email owner@example.com --commit   # apply
"""

import argparse
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from database.db import SessionLocal  # noqa: E402
from database.models import User  # noqa: E402


def main():
    ap = argparse.ArgumentParser(
        description="Promote an existing user to admin (dry-run by default).")
    ap.add_argument("--email", required=True, help="the user's login email (case-insensitive)")
    ap.add_argument("--commit", action="store_true", help="apply the change (default: dry-run)")
    args = ap.parse_args()
    email = args.email.strip().lower()

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if not user:
            print(f"No user found for '{email}'. Log in via Google (or however this "
                  f"workspace signs in) at least once so the account row exists, "
                  f"then re-run this script.")
            return

        other_admin = (
            db.query(User)
              .filter(User.org_id == user.org_id, User.role == "admin",
                      User.active == True, User.id != user.id)  # noqa: E712
              .first()
        )
        if other_admin:
            print(f"Note: {other_admin.email} already holds admin in this workspace "
                  f"(org_id={user.org_id}). Promoting {email} too is harmless (multiple "
                  f"admins are fine) but double-check this is what you want.")

        print(f"User: {user.email} (id={user.id}, org_id={user.org_id})")
        print(f"  current: role={user.role!r} status={user.status!r} active={user.active!r}")
        print(f"  will become: role='admin' status='active' active=True")

        if not args.commit:
            print("\nDry run only — nothing changed. Re-run with --commit to apply.")
            return

        user.role = "admin"
        user.status = "active"
        user.active = True
        db.commit()
        print(f"\nDone — {email} is now an active admin.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
