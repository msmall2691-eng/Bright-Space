#!/usr/bin/env python3
"""LIVE smoke test for Connecteam Job auto-creation.

Runs against the REAL Connecteam account, so it only works where the
credentials are configured (locally with the app's .env, or on Railway via
`railway run`). It:

  1. verifies credentials are present,
  2. creates a throwaway Job named "BrightBase smoke test <timestamp>",
  3. re-reads the Jobs list and confirms the new Job is there and linkable.

It does NOT delete the Job (there's no verified delete-Job endpoint wired up
yet) — remove the "BrightBase smoke test …" Job in Connecteam → Jobs when done.

Usage:
    cd backend && python scripts/manual_tests/test_connecteam_create_job_live.py
    # or on Railway:  railway run python scripts/manual_tests/test_connecteam_create_job_live.py
"""
import sys
import time

from integrations import connecteam as ct


def main() -> int:
    if not ct.is_configured():
        print("✗ Connecteam is not configured (missing API key or Scheduler ID).")
        print("  Set them in Settings → Integrations, or export CONNECTEAM_API_KEY "
              "+ CONNECTEAM_COMPANY_ID, then re-run.")
        return 2

    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    name = f"BrightBase smoke test {stamp}"
    print(f"→ Creating test Job: {name!r} on scheduler {ct._get_scheduler_id()!r}")

    try:
        job_id = ct.create_job_sync(name, address="1 Test St, Portland, ME")
    except Exception as e:  # noqa: BLE001 — surface the raw API error for diagnosis
        print(f"✗ create_job raised: {type(e).__name__}: {e}")
        print("  If this is an HTTP 400, the payload shape needs adjusting — paste "
              "this error back and it can be fixed.")
        return 1

    if not job_id:
        print("✗ create_job returned no id — the response shape may have changed. "
              "Check _extract_created_job_id against the live response.")
        return 1

    print(f"✓ Created Job id: {job_id}")

    # Confirm it's really in the account's Jobs list and would be matched by name.
    try:
        jobs = ct.get_jobs_sync(ct._get_scheduler_id())
    except Exception as e:  # noqa: BLE001
        print(f"! Created OK, but couldn't re-read Jobs list to confirm: {e}")
        return 0

    found = jobs.get(str(job_id))
    if found:
        print(f"✓ Confirmed in Jobs list: {found}")
    else:
        print(f"! Created id {job_id} not present in the re-read Jobs list "
              f"({len(jobs)} jobs) — may be an instance-scoping mismatch.")

    idx = ct.build_jobs_index(jobs)
    print(f"✓ Name match resolves to: {ct.match_job_id(idx, [name])!r} "
          f"(expected {job_id})")

    print("\nDone. Remember to delete the 'BrightBase smoke test …' Job in "
          "Connecteam → Jobs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
