"""
Connecteam public API integration.

Docs: https://developer.connecteam.com/

The initial version of this module used the wrong header and URL shape
(`Authorization: Bearer …` + `/v1/companies/{cid}/…`), which is why every
call 401'd regardless of which key was pasted in Settings. Connecteam's
public API actually wants:

  * Base URL: https://api.connecteam.com  (no `/v1` prefix; each product
    module carries its own version segment, e.g. `/scheduler/v1/…`,
    `/users/v1/…`)
  * Auth:     X-API-KEY: <key>            (NOT Authorization: Bearer)
  * Verify:   GET /me                     (cheap smoke test)
  * Users:    GET /users/v1/users
  * Shifts:   POST /scheduler/v1/schedulers/{schedulerId}/shifts
              (body is an ARRAY of up to 500 shifts; startTime/endTime
              are Unix seconds, ints)
  * Delete:   DELETE /scheduler/v1/schedulers/{schedulerId}/shifts/{shiftId}
  * List schedulers: GET /scheduler/v1/schedulers   (returns { data: { schedulers: [{ id, name, … }] } })

Everything the CRM stores as a "company id" is really the **scheduler id**
— the numeric id of the schedule you want shifts pushed into. The setting
key is kept as `connecteam_company_id` for backward compatibility (env vars
+ existing DB rows), but the UI now labels it "Scheduler ID".
"""

import os
import asyncio
import concurrent.futures
from datetime import datetime, timezone

import httpx
from typing import Optional

CONNECTEAM_BASE = "https://api.connecteam.com"


def _db_setting(key: str) -> str:
    """Read a Connecteam credential out of app_settings (Settings → Integrations),
    falling back silently when the DB isn't reachable (e.g. tests, boot). Returns
    "" on any failure so callers get the same "not configured" signal as an
    unset env var."""
    try:
        from database.db import SessionLocal
        db = SessionLocal()
        try:
            from modules.settings.router import get_setting
            return (get_setting(db, key) or "").strip()
        finally:
            db.close()
    except Exception:
        return ""


def _get_api_key() -> str:
    """API key: prefer the value the user saved in Settings; fall back to the
    CONNECTEAM_API_KEY env var so existing Railway deploys keep working."""
    return _db_setting("connecteam_api_key") or os.getenv("CONNECTEAM_API_KEY", "").strip()


def _get_scheduler_id() -> str:
    """Scheduler ID: prefer DB, fall back to env. Kept under the legacy
    `connecteam_company_id` / `CONNECTEAM_COMPANY_ID` keys so existing installs
    don't need to re-enter it — but the value semantically is a scheduler id,
    which is what the Connecteam scheduler API path requires."""
    return _db_setting("connecteam_company_id") or os.getenv("CONNECTEAM_COMPANY_ID", "").strip()


# Public alias for callers that used to say "company_id"; kept so the auto
# dispatcher and any external readers keep compiling.
def _company_id() -> str:  # noqa: N802 — backward compat name
    return _get_scheduler_id()


def is_configured() -> bool:
    """True when Connecteam credentials are present, so callers can tell
    "Connecteam isn't connected" apart from "connected but the call failed"
    (mirrors integrations.google_calendar.is_configured)."""
    return bool(_get_api_key() and _get_scheduler_id())


def _run_sync(coro):
    """Run an async Connecteam coroutine from synchronous code.

    The job lifecycle endpoints (create/update/delete_job) are sync `def`s run in
    Starlette's threadpool, where there's no running loop — so asyncio.run works.
    If a loop *is* already running (called from async code), fall back to a fresh
    thread so we never error with "loop already running".
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(lambda: asyncio.run(coro)).result()


class ConnecteamAuthError(Exception):
    """Connecteam rejected our credentials (401/403) or bounced us to a login
    redirect. Callers turn this into a 401 with 'rotate your API key' guidance
    — distinct from a transient 5xx which should retry."""


def _raise_for_status(r: httpx.Response) -> None:
    if (300 <= r.status_code < 400) or r.status_code in (401, 403):
        raise ConnecteamAuthError(
            "Connecteam credentials invalid/expired — rotate CONNECTEAM_API_KEY"
        )
    r.raise_for_status()


def _headers() -> dict:
    return {
        "X-API-KEY": _get_api_key(),
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _to_epoch_seconds(value) -> int:
    """Coerce a datetime / ISO string / int-ish into Unix seconds. Connecteam's
    scheduler API rejects millisecond values (anything > 1e12), so pre-1970
    dates and JS timestamps both need normalising here."""
    if isinstance(value, int):
        return value if value < 10**12 else value // 1000
    if isinstance(value, float):
        return int(value if value < 10**12 else value / 1000)
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    # String path — try ISO first, then a bare "YYYY-MM-DDTHH:MM:SS" (no tz);
    # local naive datetimes are treated as UTC to keep the code Railway-safe.
    s = str(value).strip()
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


# ─── Auth-smoke-test + directory endpoints ─────────────────────────────────

async def get_me() -> dict:
    """Cheapest possible authenticated call — verifies the API key AND the
    account it belongs to. Connecteam recommends `GET /me` as the "is my key
    live?" endpoint; a 200 here means everything downstream will authenticate."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{CONNECTEAM_BASE}/me", headers=_headers())
        _raise_for_status(r)
        return r.json()


async def list_schedulers() -> list:
    """List all schedulers on the account. Used by the Settings UI's Test
    button to help the operator pick the right schedulerId (the integer id
    that goes into CONNECTEAM_COMPANY_ID / the 'Scheduler ID' field).

    Response shape (per developer.connecteam.com/docs/scheduler-get-schedulers):
      { "data": { "schedulers": [
          { "schedulerId": 9454799, "name": "Main Schedule",
            "isArchived": false, "timezone": "America/New_York" }
      ] } }

    We flatten to a plain list of {id, name}, filtering out archived schedulers
    (they're read-only on Connecteam's side — pushing to one 400s with
    "schedule id doesn't exist" even though the id is technically real).

    IMPORTANT: the id field is `schedulerId`, NOT `id`. An earlier version of
    this parser looked for `id`, so the dropdown that's supposed to auto-
    populate in Settings was silently empty — which forced operators to paste
    the numeric id from the Connecteam UI URL (a frontend "component" id,
    NOT the API's schedulerId), and Connecteam then rejected shift-create
    with 400 "schedule id doesn't exist". Falling back to `id` too keeps us
    forward-compat if Connecteam ever adds one."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{CONNECTEAM_BASE}/scheduler/v1/schedulers",
                             headers=_headers())
        _raise_for_status(r)
        data = r.json()
    schedulers = ((data.get("data") or {}).get("schedulers")) or data.get("schedulers") or []
    out = []
    for s in schedulers:
        sid = s.get("schedulerId") if s.get("schedulerId") is not None else s.get("id")
        if sid is None or s.get("isArchived"):
            continue
        out.append({"id": sid, "name": s.get("name") or f"Scheduler #{sid}"})
    return out


async def get_employees() -> list:
    """Fetch all users from Connecteam via /users/v1/users. Kept because the
    /connecteam/test settings endpoint's original implementation called it —
    now largely superseded by get_me() but retained so anything that imported
    it keeps working."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{CONNECTEAM_BASE}/users/v1/users", headers=_headers())
        _raise_for_status(r)
        data = r.json()
    users = ((data.get("data") or {}).get("users")) or data.get("users") or []
    return users


# ─── Shifts ────────────────────────────────────────────────────────────────

def _shift_payload(*, start_datetime, end_datetime, title,
                   address=None, notes=None, user_id=None,
                   open_shift=False, is_published=True) -> dict:
    """Shape a single shift the way Connecteam expects. Bulk-create takes an
    ARRAY of these — call sites wrap accordingly."""
    payload = {
        "startTime": _to_epoch_seconds(start_datetime),
        "endTime": _to_epoch_seconds(end_datetime),
        "title": title,
        "isPublished": is_published,
    }
    if open_shift:
        payload["isOpenShift"] = True
        payload["assignedUserIds"] = []  # required to stay empty for open shifts
    elif user_id is not None:
        payload["assignedUserIds"] = [int(user_id)] if str(user_id).isdigit() else [user_id]
    if address:
        # locationData is a structured object. `isReferencedToJob` is REQUIRED
        # by Connecteam's validator whenever locationData is present — their
        # public docs (developer.connecteam.com/docs/scheduler-create-shifts)
        # don't mention it, but the API returns error_code 1002 without it:
        #   "body.0.locationData.isReferencedToJob": {"message":"Field..."}
        # false = free-text address, not tied to a Connecteam Job entity. Once
        # we wire up Job lookup by customer name (follow-up), a matched Job
        # will flip this to true and add a jobId to the shift.
        payload["locationData"] = {
            "address": address,
            "isReferencedToJob": False,
        }
    if notes:
        payload["notes"] = [{"html": notes}]
    return payload


def _extract_shift_ids(data: dict) -> list:
    """Bulk-create response is {"data": {"shifts": [{"id": "..."}]}}; pull the
    ids out defensively so a shape change doesn't crash our caller."""
    shifts = ((data.get("data") or {}).get("shifts")) or data.get("shifts") or []
    return [str(s.get("id")) for s in shifts if s.get("id")]


async def create_shifts(shifts: list) -> list:
    """Bulk-create shifts. Returns the created shift ids in the same order.
    Callers that need to correlate ids back to source rows should trust the
    order — Connecteam's bulk endpoint returns shifts in submission order."""
    if not shifts:
        return []
    sched = _get_scheduler_id()
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{CONNECTEAM_BASE}/scheduler/v1/schedulers/{sched}/shifts",
            headers=_headers(),
            json=shifts,
        )
        _raise_for_status(r)
        data = r.json()
    return _extract_shift_ids(data)


def create_shifts_sync(shifts: list) -> list:
    """Synchronous wrapper for bulk create — the /connecteam/push-open-shifts
    settings endpoint runs in Starlette's threadpool."""
    return _run_sync(create_shifts(shifts))


# Public alias — callers that build payloads themselves (bulk push) reach for
# this instead of duplicating the wire-format logic.
build_shift_payload = _shift_payload


async def create_shift(
    employee_id: str,
    start_datetime,
    end_datetime,
    title: str,
    address: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """Create a single ASSIGNED shift for one cleaner. Returns {"id": "..."}
    so callers that read `res["id"]` (like connecteam_auto.auto_dispatch_job)
    keep working."""
    payload = _shift_payload(
        start_datetime=start_datetime, end_datetime=end_datetime,
        title=title, address=address, notes=notes, user_id=employee_id,
    )
    ids = await create_shifts([payload])
    return {"id": ids[0]} if ids else {}


async def create_open_shift(
    start_datetime,
    end_datetime,
    title: str,
    address: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """Create a single OPEN shift (unassigned, cleaners can self-claim)."""
    payload = _shift_payload(
        start_datetime=start_datetime, end_datetime=end_datetime,
        title=title, address=address, notes=notes, open_shift=True,
    )
    ids = await create_shifts([payload])
    return {"id": ids[0]} if ids else {}


async def delete_shift(shift_id: str) -> None:
    """Delete a shift by id."""
    sched = _get_scheduler_id()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.delete(
            f"{CONNECTEAM_BASE}/scheduler/v1/schedulers/{sched}/shifts/{shift_id}",
            headers=_headers(),
        )
        _raise_for_status(r)


def create_shift_sync(**kwargs) -> dict:
    """Synchronous wrapper around create_shift for the sync job endpoints."""
    return _run_sync(create_shift(**kwargs))


def create_open_shift_sync(**kwargs) -> dict:
    """Synchronous wrapper around create_open_shift for the sync job endpoints."""
    return _run_sync(create_open_shift(**kwargs))


def delete_shift_sync(shift_id: str) -> None:
    """Synchronous wrapper around delete_shift for the sync job endpoints."""
    return _run_sync(delete_shift(shift_id))


# ─── Payroll helpers (not-yet-re-implemented) ──────────────────────────────
# The pre-rewrite code exposed get_timesheets / get_mileage against the wrong
# URL shape (/v1/timesheets etc), so those calls have always 401'd since day
# one — nothing was actually pulling payroll data. Keep the symbols so
# modules/payroll/router.py still imports, but raise a clear error until the
# Time Clock (/timeclock/v1/…) endpoints get wired up properly. The payroll
# router catches this as a ConnecteamAuthError → 503, so the UI shows
# "Connecteam error" instead of crashing.

async def get_timesheets(start_date: str, end_date: str,
                         employee_id: Optional[str] = None) -> list:
    raise ConnecteamAuthError(
        "Connecteam timesheet pull isn't wired to the /timeclock/v1 API yet. "
        "Reach out to update backend/integrations/connecteam.py.get_timesheets."
    )


async def get_mileage(start_date: str, end_date: str,
                      employee_id: Optional[str] = None) -> list:
    raise ConnecteamAuthError(
        "Connecteam mileage pull isn't wired to the current API yet. "
        "Reach out to update backend/integrations/connecteam.py.get_mileage."
    )
