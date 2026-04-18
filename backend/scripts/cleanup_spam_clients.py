#!/usr/bin/env python3
"""
Cleanup spam clients from the database.

Usage:
    python cleanup_spam_clients.py --dry-run  # Preview what would be deleted
    python cleanup_spam_clients.py --execute  # Actually delete the clients
"""

import os
import sys
import sqlite3
import re
from pathlib import Path

# Add parent dir to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app import create_app

# Email patterns for spam/no-reply addresses
SPAM_PATTERNS = [
    r'^noreply@',
    r'^no-reply@',
    r'^donotreply@',
    r'^do-not-reply@',
    r'@indeed\.com$',
    r'@mail\.attio\.com$',
    r'@toolkit\.',
    r'@replit\.com$',
    r'@tooljet\.com$',
    r'^hello@mail\.',
    r'^contact@mail\.',
    r'^team@mail\.',
    r'^.*@mail\.google\.com$',
    r'^.*@octoparse\.com$',
    r'^.*@leaseville\.com$',
    r'^.*@rocket\.',
    r'^info@mail\.',
    r'^support@mail\.',
]

def email_is_spam(email):
    """Check if email matches spam patterns."""
    if not email:
        return False
    email_lower = email.lower()
    for pattern in SPAM_PATTERNS:
        if re.search(pattern, email_lower):
            return True
    return False

def cleanup_spam_clients(execute=False):
    """Find and optionally delete spam clients."""
    app = create_app()

    # Use the database connection from the app
    with app.app_context():
        from app.models import Client
        from app import db

        # Find spam clients
        all_clients = Client.query.all()
        spam_clients = [c for c in all_clients if email_is_spam(c.email)]

        if not spam_clients:
            print("✓ No spam clients found.")
            return 0

        print(f"\nFound {len(spam_clients)} spam client(s):")
        print("-" * 80)
        for client in spam_clients:
            print(f"  ID: {client.id:4d} | {client.email:40s} | {client.name or '(no name)'}")
        print("-" * 80)

        if execute:
            print(f"\n⏳ Deleting {len(spam_clients)} spam clients...")
            for client in spam_clients:
                db.session.delete(client)
            db.session.commit()
            print(f"✓ Deleted {len(spam_clients)} clients")
        else:
            print(f"\n(Use --execute to delete these clients)")

        return len(spam_clients)

if __name__ == '__main__':
    execute = '--execute' in sys.argv
    dry_run = '--dry-run' in sys.argv or not execute

    if dry_run:
        print("🔍 DRY RUN — no changes will be made")

    cleanup_spam_clients(execute=execute)
