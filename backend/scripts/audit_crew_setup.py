"""
Read-only audit: is the crew set up for native payroll?

Native payroll pays from the crew clock, so every active cleaner login needs
to be wired up for their punches to attribute and their pay to compute. This script checks that, per org, and
never writes anything — it runs SELECTs only, so it's safe against production.

What it checks:

  1. cleaner_id linked      REQUIRED. Without it a cleaner literally can't clock
                            in (the /my-day and /clock-in endpoints 400), and no
                            punch or pay attributes to them.
  2. pay-rate overrides     OPTIONAL. A NULL pay_rate_residential / pay_rate_rental
                            just means "use the shop default" (the Settings
                            pay_rate_residential / pay_rate_rental_weekday, or the
                            built-in $25 / $26 fallback) — not a blocker.
  3. assigned-but-unlinked  crew IDs on recent jobs (Job.cleaner_ids) that match
                            no active cleaner login — people doing the work who
                            wouldn't get a native paycheck yet.
  4. duplicate cleaner_id   two logins sharing one crew ID in an org, which would
                            cross-attribute hours and pay.
  5. clock activity         native punches per cleaner in the window — who's
                            actually exercising the clock (dark-test readiness).

    cd backend
    python scripts/audit_crew_setup.py                 # all orgs, last 30 days
    python scripts/audit_crew_setup.py --org-id 1      # scope to one org
    python scripts/audit_crew_setup.py --days 60       # widen the job window
"""
import argparse
import sys
from collections import defaultdict
from datetime import datetime, time, timedelta
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from database.db import SessionLocal  # noqa: E402
from database.models import User, Job, TimeEntry  # noqa: E402
from modules.settings.router import get_setting  # noqa: E402
from utils.dates import business_today  # noqa: E402

# Shop-default fallbacks, mirroring modules/payroll/router.py. These always
# resolve, so a cleaner with no per-cleaner override is still paid the default.
RATE_DEFAULTS = {
    "pay_rate_residential": 25.0,
    "pay_rate_rental_weekday": 26.0,
    "mileage_rate": 0.67,
}


def _has_crew_id(u) -> bool:
    return bool(u.cleaner_id and str(u.cleaner_id).strip())


def _shop_rate(db, key):
    """(value, source) for a global rate: the Settings value if set, else the
    built-in default."""
    raw = get_setting(db, key)
    if raw is None or str(raw).strip() == "":
        return RATE_DEFAULTS[key], "shop default (Settings unset)"
    try:
        return float(raw), "set in Settings"
    except (TypeError, ValueError):
        return RATE_DEFAULTS[key], f"invalid Settings value {raw!r} -> default"


def _fmt_rate(v):
    return f"${v:.2f}" if v is not None else "(default)"


def main():
    ap = argparse.ArgumentParser(
        description="Audit crew cleaner_id + pay-rate setup (read-only).")
    ap.add_argument("--org-id", type=int, default=None,
                    help="scope to one org (default: every org)")
    ap.add_argument("--days", type=int, default=30,
                    help="job-assignment / punch lookback window in days (default 30)")
    args = ap.parse_args()
    window = max(1, args.days)

    db = SessionLocal()
    try:
        # ── Cleaner logins ────────────────────────────────────────────────────
        cq = db.query(User).filter(User.role == "cleaner")
        if args.org_id is not None:
            cq = cq.filter(User.org_id == args.org_id)
        cleaners = cq.order_by(User.org_id, User.full_name).all()

        # ── Recent job assignments: org -> crew_id -> job count ───────────────
        since = business_today() - timedelta(days=window)
        jq = db.query(Job).filter(Job.scheduled_date >= since)
        if args.org_id is not None:
            jq = jq.filter(Job.org_id == args.org_id)
        assigned = defaultdict(lambda: defaultdict(int))   # org -> cid -> #jobs
        for j in jq.all():
            for cid in (j.cleaner_ids or []):
                if cid:
                    assigned[j.org_id][str(cid)] += 1

        # ── Recent native punches: (org, crew_id) -> count ────────────────────
        since_dt = datetime.combine(since, time.min)       # naive UTC lower bound
        pq = db.query(TimeEntry).filter(TimeEntry.clock_in_at >= since_dt)
        if args.org_id is not None:
            pq = pq.filter(TimeEntry.org_id == args.org_id)
        punches = defaultdict(int)                         # (org, cid) -> count
        for e in pq.all():
            punches[(e.org_id, str(e.cleaner_id))] += 1

        # ── Group cleaners by org ─────────────────────────────────────────────
        by_org = defaultdict(list)
        for u in cleaners:
            by_org[u.org_id].append(u)

        scope = f"org {args.org_id}" if args.org_id is not None else "all orgs"
        print("=" * 64)
        print(f" CREW SETUP AUDIT   (scope: {scope};  window: last {window} days)")
        print("=" * 64)

        res_rate, res_src = _shop_rate(db, "pay_rate_residential")
        ren_rate, ren_src = _shop_rate(db, "pay_rate_rental_weekday")
        mil_rate, mil_src = _shop_rate(db, "mileage_rate")
        print("\nShop default pay rates (used when a cleaner has no override):")
        print(f"  residential : ${res_rate:.2f}/hr   [{res_src}]")
        print(f"  rental wkdy : ${ren_rate:.2f}/hr   [{ren_src}]")
        print(f"  mileage     : ${mil_rate:.2f}/mi   [{mil_src}]")

        # Running totals for the final summary.
        tot_active = tot_missing = tot_unlinked = tot_dupe = tot_no_punch = 0

        for org_id in sorted(by_org, key=lambda o: (o is None, o)):
            crew = by_org[org_id]
            active = [u for u in crew if u.active and u.status == "active"]
            inactive = [u for u in crew if not (u.active and u.status == "active")]

            # crew_id -> [users] within this org (any status), for the dupe check
            # and for matching job assignments back to a login.
            active_ids = {str(u.cleaner_id) for u in active if _has_crew_id(u)}
            any_ids = defaultdict(list)
            for u in crew:
                if _has_crew_id(u):
                    any_ids[str(u.cleaner_id)].append(u)

            missing = [u for u in active if not _has_crew_id(u)]
            linked = [u for u in active if _has_crew_id(u)]

            print("\n" + "-" * 64)
            print(f" Org {org_id}   —   {len(active)} active cleaner login(s)")
            print("-" * 64)
            tot_active += len(active)

            # 1. Missing crew ID (the blocker).
            if missing:
                tot_missing += len(missing)
                print(f"\n  ❌ {len(missing)} MISSING crew ID (can't clock in / not paid natively):")
                for u in missing:
                    print(f"       - {u.email}  (id={u.id})  {u.full_name or ''}".rstrip())
            else:
                print("\n  ✅ every active cleaner has a crew ID linked")

            # 2. Linked cleaners + their rate overrides + recent punch counts.
            if linked:
                print(f"\n  Linked cleaners ({len(linked)}):")
                print(f"     {'crew_id':<14}{'name':<20}{'res':<10}{'rental':<10}{'punches':<8}")
                print(f"     {'-'*13:<14}{'-'*19:<20}{'-'*9:<10}{'-'*9:<10}{'-'*7:<8}")
                for u in sorted(linked, key=lambda x: str(x.cleaner_id)):
                    n = punches.get((org_id, str(u.cleaner_id)), 0)
                    if n == 0:
                        tot_no_punch += 1
                    print(f"     {str(u.cleaner_id):<14}{(u.full_name or u.email)[:19]:<20}"
                          f"{_fmt_rate(u.pay_rate_residential):<10}{_fmt_rate(u.pay_rate_rental):<10}{n:<8}")

            # 3. Crew IDs on recent jobs with no active login.
            org_assigned = assigned.get(org_id, {})
            unlinked = {cid: cnt for cid, cnt in org_assigned.items() if cid not in active_ids}
            if unlinked:
                tot_unlinked += len(unlinked)
                print(f"\n  ⚠ {len(unlinked)} crew ID(s) on recent jobs with NO active login"
                      f" (won't be paid natively):")
                for cid, cnt in sorted(unlinked.items(), key=lambda kv: -kv[1]):
                    note = ""
                    if cid in any_ids:  # a login exists but isn't active/approved
                        who = ", ".join(f"{u.email} [{u.status}/active={u.active}]" for u in any_ids[cid])
                        note = f"  (login exists but not active: {who})"
                    print(f"       - {cid}   on {cnt} job(s) in the last {window}d{note}")

            # 4. Duplicate crew IDs within the org.
            dupes = {cid: us for cid, us in any_ids.items() if len(us) > 1}
            if dupes:
                tot_dupe += len(dupes)
                print(f"\n  ⚠ {len(dupes)} duplicate crew ID(s) (cross-attribution risk):")
                for cid, us in dupes.items():
                    print(f"       - {cid} shared by: {', '.join(u.email for u in us)}")

            if inactive:
                print(f"\n  ({len(inactive)} pending/disabled cleaner login(s) not counted above)")

        # ── Summary ───────────────────────────────────────────────────────────
        print("\n" + "=" * 64)
        print(" SUMMARY")
        print(f"   Active cleaner logins:        {tot_active}")
        print(f"   ❌ Missing crew ID:            {tot_missing}   <- fix before cutover")
        print(f"   ⚠ Assigned-but-unlinked IDs:  {tot_unlinked}")
        print(f"   ⚠ Duplicate crew IDs:         {tot_dupe}")
        print(f"   Linked cleaners, 0 punches:   {tot_no_punch}   (haven't tried the native clock)")
        print("=" * 64)

        if tot_missing or tot_unlinked or tot_dupe:
            print("\nTO FIX before flipping payroll to native:")
            if tot_missing:
                print("  • Set a crew ID for each ❌ cleaner: Settings -> Users -> edit -> Crew ID.")
            if tot_unlinked:
                print("  • Decide whether each ⚠ assigned-but-unlinked crew ID needs a BrightBase login.")
            if tot_dupe:
                print("  • Resolve duplicate crew IDs so hours/pay don't cross-attribute.")
        else:
            print("\n✅ No blockers found — every active cleaner is linked and unique.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
