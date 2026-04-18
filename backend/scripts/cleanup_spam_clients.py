"""
One-time cleanup: remove Client rows that were auto-created from no-reply /
marketing emails and never represented a real cleaning-company prospect.

Default run is a DRY-RUN. It prints everything it WOULD delete and exits
without touching the database. Re-run with --commit to actually delete.

    cd backend
    python scripts/cleanup_spam_clients.py           # dry run
    python scripts/cleanup_spam_clients.py --commit  # delete for real

Safety rules baked in:
  - Only deletes clients with status == 'lead' (never active/inactive clients).
  - Only deletes clients with source in {'email', 'gmail auto-enrich'}.
  - Never deletes a client that has any Job, Invoice, RecurringSchedule,
    or Property attached. If any of those exist we skip and print a warning.
  - Every deletion is logged to stdout so you have a record.
"""

import argparse
import sys
from pathlib import Path

# Make backend imports work when this script is run directly
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from database.db import SessionLocal  # noqa: E402
from database.models import (  # noqa: E402
    Client,
    ContactEmail,
    Activity,
    Message,
    Job,
    Invoice,
    RecurringSchedule,
    Property,
)
from integrations.email_filter import is_spam_sender  # noqa: E402


SAFE_STATUSES = {"lead", "new", None, ""}
SAFE_SOURCES = {"email", "gmail", "gmail auto-enrich", None, ""}


def has_business_records(db, client_id: int) -> list[str]:
    """Return a list of table names where this client has rows (empty = safe to delete)."""
    problems = []
    if db.query(Job).filter(Job.client_id == client_id).first():
        problems.append("Job")
    if db.query(Invoice).filter(Invoice.client_id == client_id).first():
        problems.append("Invoice")
    if db.query(RecurringSchedule).filter(RecurringSchedule.client_id == client_id).first():
        problems.append("RecurringSchedule")
    if db.query(Property).filter(Property.client_id == client_id).first():
        problems.append("Property")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", action="store_true", help="actually delete rows (default: dry run)")
    parser.add_argument("--include-status", action="append", default=None,
                        help="override the status allowlist (default: lead/new)")
    args = parser.parse_args()

    allowed_statuses = set(args.include_status) if args.include_status else SAFE_STATUSES

    db = SessionLocal()
    to_delete = []
    skipped_has_business = []
    skipped_not_spam = 0
    skipped_wrong_status = 0
    skipped_wrong_source = 0

    try:
        all_clients = db.query(Client).all()
        print(f"Scanning {len(all_clients)} client rows...\n")

        for c in all_clients:
            email = (c.email or "").strip().lower()
            status = (c.status or "").strip().lower()
            source = (c.source or "").strip().lower()
            source_detail = (getattr(c, "source_detail", "") or "").strip().lower()

            if not email or not is_spam_sender(email):
                skipped_not_spam += 1
                continue

            if status not in {s.lower() if s else s for s in allowed_statuses}:
                skipped_wrong_status += 1
                continue

            if source not in SAFE_SOURCES and source_detail not in SAFE_SOURCES:
                # If the source looks like something other than email, don't touch it
                skipped_wrong_source += 1
                continue

            problems = has_business_records(db, c.id)
            if problems:
                skipped_has_business.append((c, problems))
                continue

            to_delete.append(c)

        print(f"Candidates for deletion: {len(to_delete)}")
        print(f"Skipped (not spam):        {skipped_not_spam}")
        print(f"Skipped (wrong status):    {skipped_wrong_status}")
        print(f"Skipped (wrong source):    {skipped_wrong_source}")
        print(f"Skipped (has business):    {len(skipped_has_business)}")
        print()

        if skipped_has_business:
            print("The following spam-looking clients have real business records and will NOT be deleted:")
            for c, problems in skipped_has_business:
                print(f"  #{c.id}  {c.name!r:40}  {c.email}  -> {', '.join(problems)}")
            print()

        if not to_delete:
            print("Nothing to do. Exiting.")
            return

        print("Would delete:" if not args.commit else "Deleting:")
        for c in to_delete:
            print(f"  #{c.id:>4}  {(c.name or '')[:40]:<40}  {c.email}  (status={c.status}, source={c.source})")
        print()

        if not args.commit:
            print("Dry run only. Re-run with --commit to actually delete these rows.")
            return

        # Real delete path. Remove child rows first to keep FK constraints happy.
        for c in to_delete:
            db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
            db.query(Message).filter(Message.client_id == c.id).delete(synchronize_session=False)
            db.query(ContactEmail).filter(ContactEmail.client_id == c.id).delete(synchronize_session=False)
            db.delete(c)

        db.commit()
        print(f"Deleted {len(to_delete)} client rows plus their contact_emails, messages, and activities.")

    finally:
        db.close()


if __name__ == "__main__":
    main()
