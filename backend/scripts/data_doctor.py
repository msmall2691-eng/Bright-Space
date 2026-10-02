"""Read-only data-quality scan — the whole-schema sibling of the recurring
health scan. Runs the same checks as GET /api/admin/data-health, but from the
command line and (by default) across every workspace, so it's handy for a
scheduled sweep or a quick "is the data sound?" before a migration.

It only SELECTs — it never writes, and it never deletes (scheduling-invariants
R7). It reports; a human fixes, through the normal UI. See
services/data_doctor.py and the data-doctor skill.

    cd backend
    python scripts/data_doctor.py                 # all workspaces
    python scripts/data_doctor.py --org-id 1      # scope to one workspace
    python scripts/data_doctor.py --json          # machine-readable output
"""
import argparse
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from database.db import SessionLocal  # noqa: E402
from services.data_doctor import run_data_scan  # noqa: E402

_MARK = {"error": "✗", "warn": "!", "info": "·"}


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only BrightBase data-quality scan.")
    ap.add_argument("--org-id", type=int, default=None,
                    help="Scope to one workspace (default: all workspaces).")
    ap.add_argument("--json", action="store_true", help="Emit the raw report as JSON.")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        report = run_data_scan(db, org_id=args.org_id)
    finally:
        db.close()

    if args.json:
        print(json.dumps(report, indent=2, default=str))
        # Non-zero exit when any error-severity finding exists, so a cron/CI can gate on it.
        return 1 if report["summary"].get("error") else 0

    scope = f"workspace {args.org_id}" if args.org_id is not None else "all workspaces"
    s = report["summary"]
    print(f"\nData Doctor — {scope} — {report['generated_at']}")
    print(f"  {s['error']} error · {s['warn']} warn · {s['info']} info "
          f"({s['total_findings']} findings)")
    if report["healthy"]:
        print("  ✓ No issues found.\n")
        return 0
    print()
    for f in report["findings"]:
        print(f"  {_MARK.get(f['severity'], '?')} [{f['severity']}] {f['code']} — {f['message']}")
        if f["sample_ids"]:
            shown = ", ".join(str(i) for i in f["sample_ids"])
            print(f"      sample: {shown}{' …' if f['truncated'] else ''}")
        print(f"      fix: {f['suggestion']}")
    print()
    return 1 if s.get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
