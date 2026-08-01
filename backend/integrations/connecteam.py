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
import logging
import re
import time as _time
from datetime import datetime, timezone

import httpx
from typing import Optional

log = logging.getLogger(__name__)

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


def _get_timeclock_id() -> str:
    """Time Clock ID: the numeric id of the Time Clock whose punches drive
    payroll. Separate from the scheduler id — the scheduler is where the CRM
    pushes shifts, the time clock is where crew actually clock in/out. Prefer
    the Settings value, fall back to env. Empty string when unset — callers
    auto-pick the first live time clock via list_time_clocks()."""
    return _db_setting("connecteam_timeclock_id") or os.getenv("CONNECTEAM_TIMECLOCK_ID", "").strip()


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


def is_bad_request(exc) -> bool:
    """True only for a DEFINITIVE client-side rejection — HTTP 400/404/422,
    i.e. Connecteam refused the request body (e.g. an invalid jobId) and created
    nothing. A read timeout, connection error, or 5xx is NOT definitive: the
    shift may in fact have been created, so callers must not treat those as a
    safe cue to retry (that would create a duplicate). Used to gate the
    linked→unlinked shift fallback."""
    resp = getattr(exc, "response", None)
    return getattr(resp, "status_code", None) in (400, 404, 422)


def _headers() -> dict:
    return {
        "X-API-KEY": _get_api_key(),
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _to_epoch_seconds(value) -> int:
    """Coerce a datetime / ISO string / int-ish into Unix seconds. Connecteam's
    scheduler API rejects millisecond values (anything > 1e12), so pre-1970
    dates and JS timestamps both need normalising here.

    Naive (tz-less) datetimes and strings are the job's BUSINESS-LOCAL wall-clock
    — a job's scheduled_date + start_time are stored as America/New_York local
    time (see connecteam_auto._shift_times, which formats them straight into a
    naive "YYYY-MM-DDTHH:MM:SS"). They must be interpreted in the business
    timezone, NOT UTC: Connecteam stores shifts as absolute epochs and renders
    them in the scheduler's own timezone (America/New_York), so a 9:00 AM job
    tagged as 9:00 UTC would show up on the cleaner's Connecteam schedule 4-5
    hours off. tz-aware inputs keep their offset untouched. NOTE: anything that
    reverses an epoch back to a wall-clock must localize with the SAME business
    tz so the times round-trip exactly."""
    from utils.dates import business_tz
    if isinstance(value, int):
        return value if value < 10**12 else value // 1000
    if isinstance(value, float):
        return int(value if value < 10**12 else value / 1000)
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=business_tz())
        return int(dt.timestamp())
    # String path — try ISO first, then a bare "YYYY-MM-DDTHH:MM:SS" (no tz).
    s = str(value).strip()
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=business_tz())
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
                   open_shift=False, is_published=True, job_id=None) -> dict:
    """Shape a single shift the way Connecteam expects. Bulk-create takes an
    ARRAY of these — call sites wrap accordingly.

    When ``job_id`` is given, the shift is LINKED to that Connecteam Job entity
    (from the account's Jobs list): jobId is a top-level field, and
    locationData.isReferencedToJob=true makes the shift inherit the job's
    location — so the shift shows the customer/property, not a free-text address.
    When it's absent we fall back to a free-text address shift (isReferencedToJob
    stays false, the historical behavior).
    """
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
    if job_id:
        # Linked to a Connecteam Job. jobId is top-level; isReferencedToJob=true
        # (inside the REQUIRED locationData object) inherits the job's saved
        # location so we don't fight it with a free-text address.
        payload["jobId"] = str(job_id)
        payload["locationData"] = {"isReferencedToJob": True}
    elif address:
        # locationData is a structured object. `isReferencedToJob` is REQUIRED
        # by Connecteam's validator whenever locationData is present — their
        # public docs (developer.connecteam.com/docs/scheduler-create-shifts)
        # don't mention it, but the API returns error_code 1002 without it:
        #   "body.0.locationData.isReferencedToJob": {"message":"Field..."}
        # false = free-text address, not tied to a Connecteam Job entity.
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


def get_scheduled_shifts_sync(start_date: str, end_date: str,
                              scheduler_id: Optional[str] = None) -> list:
    """Synchronous wrapper around get_scheduled_shifts for the read-back
    reconcile (which runs in the request threadpool / scheduler thread)."""
    return _run_sync(get_scheduled_shifts(start_date, end_date, scheduler_id))


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
    is_published: bool = True,
    job_id: Optional[str] = None,
) -> dict:
    """Create a single ASSIGNED shift for one cleaner. Returns {"id": "..."}
    so callers that read `res["id"]` (like connecteam_auto.auto_dispatch_job)
    keep working. is_published=False pushes it as an unpublished DRAFT the
    office can review/publish in Connecteam. ``job_id`` links it to a Connecteam
    Job entity."""
    payload = _shift_payload(
        start_datetime=start_datetime, end_datetime=end_datetime,
        title=title, address=address, notes=notes, user_id=employee_id,
        is_published=is_published, job_id=job_id,
    )
    ids = await create_shifts([payload])
    return {"id": ids[0]} if ids else {}


async def create_open_shift(
    start_datetime,
    end_datetime,
    title: str,
    address: Optional[str] = None,
    notes: Optional[str] = None,
    is_published: bool = True,
    job_id: Optional[str] = None,
) -> dict:
    """Create a single OPEN shift (unassigned, cleaners can self-claim).
    is_published=False pushes it as an unpublished DRAFT. ``job_id`` links it to
    a Connecteam Job entity (still unassigned — a person is assigned in
    Connecteam)."""
    payload = _shift_payload(
        start_datetime=start_datetime, end_datetime=end_datetime,
        title=title, address=address, notes=notes, open_shift=True,
        is_published=is_published, job_id=job_id,
    )
    ids = await create_shifts([payload])
    return {"id": ids[0]} if ids else {}


async def delete_shift(shift_id: str) -> None:
    """Delete a shift by id. Idempotent: a 404 means the shift is already gone
    from Connecteam, which is exactly the goal of a delete — treat it as
    success. Without this, re-pushing a job whose shift was deleted IN
    Connecteam failed here, so remove_job_from_connecteam kept the stale id and
    auto_dispatch_job then skipped it ("already_dispatched") — the re-send
    reported success but created no fresh draft (Codex P2)."""
    sched = _get_scheduler_id()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.delete(
            f"{CONNECTEAM_BASE}/scheduler/v1/schedulers/{sched}/shifts/{shift_id}",
            headers=_headers(),
        )
    if r.status_code == 404:
        return
    _raise_for_status(r)


def create_shift_sync(**kwargs) -> dict:
    """Synchronous wrapper around create_shift for the sync job endpoints."""
    return _run_sync(create_shift(**kwargs))


def create_open_shift_sync(**kwargs) -> dict:
    """Synchronous wrapper around create_open_shift for the sync job endpoints."""
    return _run_sync(create_open_shift(**kwargs))


def get_jobs_sync(instance_id: Optional[str] = None) -> dict:
    """Synchronous wrapper around get_jobs (the account's Jobs list) for the
    settings/diagnostic endpoints, which run in Starlette's threadpool."""
    return _run_sync(get_jobs(instance_id))


def delete_shift_sync(shift_id: str) -> None:
    """Synchronous wrapper around delete_shift for the sync job endpoints."""
    return _run_sync(delete_shift(shift_id))


# ─── Time Clock (payroll) ──────────────────────────────────────────────────
# Timesheets come out of the Time Clock module, NOT the scheduler. The data
# model is:
#   * List time clocks:   GET /time-clock/v1/time-clocks
#   * Time activities:    GET /time-clock/v1/time-clocks/{id}/time-activities
#                         ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
#     → { data: { timeActivitiesByUsers: [ { userId, shifts: [...],
#         manualBreaks: [...], timeOffs: [...] } ] } }
#     Each shift carries start/end {timestamp, timezone, locationData}, jobId,
#     subJobId, schedulerShiftId (links back to a CRM-pushed scheduler shift),
#     employeeNote, and customFields/shiftAttachments (where crew enter mileage
#     at clock-out — Connecteam has no automatic mileage tracking).
#   * Jobs (names):       GET /jobs/v1/jobs?instanceIds={id}
#     → resolve jobId → title so residential vs rental can be classified.
#
# The date range Connecteam allows is 92 days max; callers should keep pay
# periods well under that.


async def list_time_clocks() -> list:
    """List all time clocks on the account. Used by the Settings picker so the
    operator can choose which time clock feeds payroll (mirrors
    list_schedulers). Flattens to [{id, name}], skipping archived clocks."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{CONNECTEAM_BASE}/time-clock/v1/time-clocks",
                             headers=_headers())
        _raise_for_status(r)
        data = r.json()
    clocks = ((data.get("data") or {}).get("timeClocks")) or data.get("timeClocks") or []
    out = []
    for c in clocks:
        cid = c.get("timeClockId") if c.get("timeClockId") is not None else c.get("id")
        if cid is None or c.get("isArchived"):
            continue
        out.append({"id": cid, "name": c.get("name") or f"Time Clock #{cid}"})
    return out


async def _resolve_timeclock_id() -> str:
    """The configured time clock id, or — when unset — the first live one on
    the account so payroll works out of the box for single-clock accounts."""
    tc = _get_timeclock_id()
    if tc:
        return tc
    clocks = await list_time_clocks()
    if not clocks:
        raise ConnecteamAuthError(
            "No Connecteam time clock found. Set the Time Clock ID in "
            "Settings → Integrations, or check the API key's permissions."
        )
    return str(clocks[0]["id"])


async def get_jobs(instance_id: Optional[str] = None) -> dict:
    """Map Connecteam jobId → job metadata for an instance (time clock or
    scheduler). Returns { jobId: {"name": str, "code": str} } so callers can
    turn the bare jobId on a shift into a human name for residential/rental
    classification. Paginates (Connecteam defaults to 10 per page)."""
    inst = instance_id or _get_timeclock_id() or _get_scheduler_id()
    params: dict = {"limit": 500, "offset": 0, "includeDeleted": True}
    if inst:
        params["instanceIds"] = inst
    out: dict = {}
    async with httpx.AsyncClient(timeout=20) as client:
        while True:
            r = await client.get(f"{CONNECTEAM_BASE}/jobs/v1/jobs",
                                 headers=_headers(), params=params)
            _raise_for_status(r)
            data = r.json()
            jobs = ((data.get("data") or {}).get("jobs")) or data.get("jobs") or []
            for j in jobs:
                jid = j.get("jobId") if j.get("jobId") is not None else j.get("id")
                if jid is None:
                    continue
                out[str(jid)] = {
                    "name": j.get("title") or j.get("name") or f"Job {jid}",
                    "code": j.get("jobCode") or j.get("code") or "",
                }
            if len(jobs) < params["limit"]:
                break
            params["offset"] += params["limit"]
    return out


def _extract_created_job_id(data: dict) -> Optional[str]:
    """Pull the new jobId out of a create-Job response, defensively. Connecteam
    wraps the created entity a couple of ways depending on the module version
    ({"data": {"job": {...}}} or {"data": {"jobs": [{...}]}} or a bare object),
    so probe each and read jobId/id. Returns None if nothing job-shaped is found
    — the caller then falls back to an unlinked free-text shift."""
    d = data.get("data") if isinstance(data.get("data"), dict) else data
    node = None
    if isinstance(d, dict):
        node = d.get("job")
        if node is None:
            jobs = d.get("jobs")
            if isinstance(jobs, list) and jobs:
                node = jobs[0]
    if node is None and isinstance(d, dict) and (d.get("jobId") or d.get("id")):
        node = d
    if not isinstance(node, dict):
        return None
    jid = node.get("jobId") if node.get("jobId") is not None else node.get("id")
    return str(jid) if jid is not None else None


async def create_job(name: str, *, address: Optional[str] = None,
                     code: Optional[str] = None,
                     instance_id: Optional[str] = None) -> Optional[str]:
    """Create a Job entity in the account's Jobs list and return its new jobId
    (or None if the response carries no id).

    A shift can only LINK to a Connecteam Job that already exists; this is how
    BrightBase makes that Job when there's no match yet — so booking a fresh
    client/property auto-creates its Connecteam Job instead of falling back to a
    blank free-text open shift. The new Job is assigned to the SCHEDULER instance
    (the one shifts are pushed into) so the linked shift lands under it.

    Body shape per developer.connecteam.com/docs/create-jobs — verified against
    the live contract:
      * The endpoint takes an ARRAY of job objects.
      * REQUIRED per job: ``title`` (max 128 chars), ``instanceIds`` (array), and
        an ``assign`` object — ``{"type": "both", "userIds": [], "groupIds": []}``
        (type MUST be "both"; empty user/group arrays = unassigned, which is what
        we want since assignment happens on the shift).
      * Optional: ``code``, ``description``, ``color``, ``gps``
        ({address, longitude, latitude}).
    The new jobId comes back at ``data.jobs[0].jobId``.
    """
    inst = instance_id or _get_scheduler_id()
    job: dict = {
        # Connecteam caps the title at 128 chars — truncate so an over-long
        # property/client name is a valid create rather than a 400.
        "title": (name or "")[:128],
        # Required. Empty user/group arrays create an UNASSIGNED job; the cleaner
        # is assigned on the shift, not the Job.
        "assign": {"type": "both", "userIds": [], "groupIds": []},
    }
    if code:
        job["code"] = code
    if inst:
        # Required. Scope the Job to the scheduler instance so a shift pushed into
        # that scheduler can reference it. Ints when numeric (the id shape
        # Connecteam emits); left as-is otherwise.
        job["instanceIds"] = [int(inst)] if str(inst).isdigit() else [inst]
    if address:
        # Optional GPS block; the plain address string is enough for the shift to
        # inherit a location (lat/long omitted — Connecteam geocodes the address).
        job["gps"] = {"address": address}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(f"{CONNECTEAM_BASE}/jobs/v1/jobs",
                              headers=_headers(), json=[job])
        _raise_for_status(r)
        data = r.json()
    return _extract_created_job_id(data)


def create_job_sync(name: str, **kwargs) -> Optional[str]:
    """Synchronous wrapper around create_job for the sync dispatch path."""
    return _run_sync(create_job(name, **kwargs))


# --- Connecteam Job matching -------------------------------------------------
# Link each pushed shift to the Connecteam Job (from the account's Jobs list)
# for its customer/property, so shifts show the job — not a free-text address —
# and land under the right job in Connecteam. Match is by normalized name
# (the account runs one Job per client/property). The Jobs list changes rarely,
# so it's cached briefly to avoid an API round-trip on every shift push.
_JOBS_CACHE: dict = {"ts": 0.0, "by_norm": {}}
_JOBS_CACHE_TTL = 600  # seconds


def _norm_name(s: Optional[str]) -> str:
    """Lowercase, strip punctuation, collapse whitespace — so 'Pier House #2'
    and 'pier house 2' match."""
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def build_jobs_index(jobs) -> dict:
    """Turn a {jobId: {"name",...}} map into a normalized name → jobId index
    (first name wins on collision). Shared by the cached dispatch resolver and
    the diagnostic preview so both match identically."""
    idx: dict = {}
    for jid, meta in (jobs or {}).items():
        n = _norm_name((meta or {}).get("name"))
        if n and n not in idx:
            idx[n] = str(jid)
    return idx


def match_job_id(idx: dict, candidates) -> Optional[str]:
    """Best match in a normalized name→jobId index for the candidate names.
    Candidates are tried in PRIORITY ORDER (caller passes property name first,
    then client), and each is FULLY resolved — exact normalized match, then
    containment either direction ('Pier House' ↔ 'Pier House Cottage') — before
    moving on. So a property containment match beats a client exact match."""
    for c in (candidates or []):
        n = _norm_name(c)
        if not n:
            continue
        if n in idx:                  # exact for THIS candidate
            return idx[n]
        hits = [(name, jid) for name, jid in idx.items() if n in name or name in n]
        if hits:                      # then containment (longest job name wins)
            return max(hits, key=lambda kv: len(kv[0]))[1]
    return None


def _jobs_index(force: bool = False) -> dict:
    """Normalized Connecteam-job-name → jobId for the SCHEDULER instance (the
    one shifts are pushed into), cached. Returns the last good index (possibly
    stale/empty) on any failure — never raises into a shift push."""
    now = _time.time()
    if not force and _JOBS_CACHE["by_norm"] and (now - _JOBS_CACHE["ts"] < _JOBS_CACHE_TTL):
        return _JOBS_CACHE["by_norm"]
    try:
        jobs = _run_sync(get_jobs(_get_scheduler_id()))
    except Exception as e:  # pragma: no cover - network/auth; keep stale index
        log.warning("[connecteam] could not refresh Jobs list for linking: %s", e)
        return _JOBS_CACHE["by_norm"]
    _JOBS_CACHE["by_norm"] = build_jobs_index(jobs)
    _JOBS_CACHE["ts"] = now
    return _JOBS_CACHE["by_norm"]


def _index_job(name: Optional[str], job_id: str) -> None:
    """Add a just-created Job to the cached name→id index so the next shift for
    the same customer/property (this dispatch, or any within the cache TTL)
    reuses it instead of creating a duplicate. No-op on a blank name."""
    n = _norm_name(name)
    if n and job_id:
        _JOBS_CACHE.setdefault("by_norm", {})
        # Only fill a gap — never clobber an existing mapping (an operator-made
        # Job of the same name should win over one we just created).
        _JOBS_CACHE["by_norm"].setdefault(n, str(job_id))


def resolve_job_id(candidates) -> Optional[str]:
    """Best-effort: the SCHEDULER Job id whose name matches one of the given
    BrightBase names (property first, then client), or None. Never raises."""
    try:
        idx = _jobs_index()
        if not idx:
            return None
        return match_job_id(idx, candidates)
    except Exception as e:  # pragma: no cover - matching must never break a push
        log.warning("[connecteam] job-id resolve failed: %s", e)
    return None


def _shift_net_minutes(shift: dict, user_breaks: list) -> float:
    """Worked minutes for a shift = elapsed time minus any manual breaks that
    fall inside it. Connecteam's break handling (paid/unpaid) is configured
    per-clock and not exposed on the activity, so we subtract every manual
    break overlapping the shift window — the common 'unpaid lunch' case. Open
    (not-yet-clocked-out) shifts have no end and count as 0."""
    start = (shift.get("start") or {}).get("timestamp")
    end = (shift.get("end") or {}).get("timestamp")
    if not start or not end or end <= start:
        return 0.0
    minutes = (end - start) / 60.0
    for br in user_breaks or []:
        bs = (br.get("start") or {}).get("timestamp")
        be = (br.get("end") or {}).get("timestamp")
        if bs and be and be > bs and bs >= start and be <= end:
            minutes -= (be - bs) / 60.0
    return max(0.0, minutes)


def _breaks_minutes(shift: dict, user_breaks: list) -> float:
    """Total minutes of manual break inside a shift's window — surfaced in the
    detailed timesheet view so the operator can see paid time vs break time."""
    start = (shift.get("start") or {}).get("timestamp")
    end = (shift.get("end") or {}).get("timestamp")
    if not start or not end:
        return 0.0
    total = 0.0
    for br in user_breaks or []:
        bs = (br.get("start") or {}).get("timestamp")
        be = (br.get("end") or {}).get("timestamp")
        if bs and be and be > bs and bs >= start and be <= end:
            total += (be - bs) / 60.0
    return round(total, 2)


def _location_str(node: dict) -> str:
    """Human-readable clock location from a start/end node's locationData —
    the address if Connecteam reverse-geocoded it, else raw lat/lng."""
    loc = (node or {}).get("locationData") or {}
    addr = loc.get("address")
    if addr:
        return str(addr)
    lat, lng = loc.get("latitude"), loc.get("longitude")
    if lat is not None and lng is not None:
        return f"{lat:.5f}, {lng:.5f}"
    return ""


def _extract_mileage(shift: dict) -> float:
    """Pull the mileage number a cleaner entered at clock-out. Connecteam has
    no native mileage field, so operators add it as a shift custom field or
    shift attachment — we scan both for an entry whose title mentions 'mile'
    and take its numeric value. Returns 0.0 when none is present."""
    candidates = list(shift.get("customFields") or [])
    candidates += list(shift.get("shiftAttachments") or [])
    for f in candidates:
        title = str(f.get("title") or f.get("name") or "").lower()
        if "mile" not in title:
            continue
        val = f.get("value")
        if val is None:
            val = f.get("number") if f.get("number") is not None else f.get("text")
        try:
            return float(str(val).strip())
        except (TypeError, ValueError):
            continue
    return 0.0


async def get_time_activities(start_date: str, end_date: str,
                              timeclock_id: Optional[str] = None,
                              employee_id: Optional[str] = None) -> list:
    """Fetch every worked shift in the window as flat, normalized rows. Each
    row is one shift, annotated with the fields payroll actually needs:

      {
        "userId": int, "shiftId": str,
        "startTimestamp": int, "endTimestamp": int, "timezone": str,
        "netMinutes": float, "netHours": float,
        "jobId": str|None, "subJobId": str|None,
        "schedulerShiftId": str|None,      # links to CRM connecteam_shift_ids
        "employeeNote": str, "miles": float,
      }

    Breaks are subtracted; open shifts are dropped. The caller layers on
    residential/rental classification and pay rules — this function stays
    purely about faithfully reading Connecteam."""
    tc = timeclock_id or await _resolve_timeclock_id()
    params: dict = {"startDate": start_date, "endDate": end_date}
    if employee_id:
        params["userIds"] = employee_id
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{CONNECTEAM_BASE}/time-clock/v1/time-clocks/{tc}/time-activities",
            headers=_headers(), params=params,
        )
        _raise_for_status(r)
        data = r.json()
    by_users = ((data.get("data") or {}).get("timeActivitiesByUsers")) \
        or data.get("timeActivitiesByUsers") or []
    rows: list = []
    for u in by_users:
        uid = u.get("userId")
        user_breaks = u.get("manualBreaks") or []
        for s in (u.get("shifts") or []):
            start = (s.get("start") or {}).get("timestamp")
            end = (s.get("end") or {}).get("timestamp")
            if not start or not end:
                continue  # open / in-progress shift — nothing to pay yet
            net = _shift_net_minutes(s, user_breaks)
            rows.append({
                "userId": uid,
                "shiftId": str(s.get("id") or ""),
                "startTimestamp": start,
                "endTimestamp": end,
                "timezone": (s.get("start") or {}).get("timezone") or "",
                "netMinutes": round(net, 2),
                "netHours": round(net / 60.0, 4),
                "jobId": str(s.get("jobId")) if s.get("jobId") is not None else None,
                "subJobId": str(s.get("subJobId")) if s.get("subJobId") is not None else None,
                "schedulerShiftId": str(s.get("schedulerShiftId")) if s.get("schedulerShiftId") is not None else None,
                "employeeNote": s.get("employeeNote") or "",
                "managerNote": s.get("managerNote") or "",
                "miles": _extract_mileage(s),
                # Richer fields for the detailed-timesheet view (payroll ignores
                # these; they're additive so the pay math is unaffected).
                "breaksMinutes": _breaks_minutes(s, user_breaks),
                "startLocation": _location_str(s.get("start")),
                "endLocation": _location_str(s.get("end")),
                "isAutoClockOut": bool(s.get("isAutoClockOut")),
            })
    return rows


def _deep_find_number(obj, keys: tuple):
    """Return the first numeric value found under any of `keys`, searching one
    level into nested dicts (Connecteam sometimes nests {"hours": n} under a
    total object). Used to read totals from an endpoint whose exact field
    names aren't pinned in the public docs."""
    if not isinstance(obj, dict):
        return None
    for k in keys:
        if k in obj:
            v = obj[k]
            if isinstance(v, (int, float)):
                return float(v)
            if isinstance(v, dict):
                for ik in ("hours", "value", "total", "amount"):
                    iv = v.get(ik)
                    if isinstance(iv, (int, float)):
                        return float(iv)
    return None


async def get_timesheet_totals(start_date: str, end_date: str) -> dict:
    """Connecteam's OWN official total hours per user for a period — the exact
    number the Connecteam timesheet UI shows (their rounding, unpaid-break, and
    overtime rules already applied). We use this as the authoritative "Total
    Hours" so BrightBase reconciles to Connecteam to the decimal.

    Returns { userId(str) → {"hours": float, "pay": float|None} }. The response
    schema isn't fully documented, so this probes several container/field names
    and returns {} on anything it can't read — callers then fall back to the
    punch-summed total. Range is capped by Connecteam at 45 days."""
    tc = await _resolve_timeclock_id()
    params = {"startDate": start_date, "endDate": end_date}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{CONNECTEAM_BASE}/time-clock/v1/time-clocks/{tc}/timesheet",
            headers=_headers(), params=params,
        )
        _raise_for_status(r)
        data = r.json()
    d = data.get("data") if isinstance(data.get("data"), dict) else data
    rows = None
    for key in ("timesheets", "usersTimesheets", "timesheetsByUsers",
                "users", "userTimesheets", "results"):
        if isinstance(d, dict) and isinstance(d.get(key), list):
            rows = d[key]
            break
    if rows is None and isinstance(d, list):
        rows = d
    out: dict = {}
    for row in (rows or []):
        if not isinstance(row, dict):
            continue
        uid = row.get("userId") if row.get("userId") is not None else row.get("id")
        if uid is None:
            continue
        # "Total hours" in the UI = regular + overtime. Prefer an explicit
        # total field; else sum regular + overtime; else any hours-ish field.
        hours = _deep_find_number(row, ("totalHours", "totalWorkedHours",
                                        "workedHours", "total"))
        if hours is None:
            reg = _deep_find_number(row, ("regularHours", "regular")) or 0.0
            ot = _deep_find_number(row, ("overtimeHours", "overtime")) or 0.0
            hours = (reg + ot) if (reg or ot) else _deep_find_number(row, ("hours",))
        if hours is None:
            continue
        out[str(uid)] = {
            "hours": round(float(hours), 2),
            "pay": _deep_find_number(row, ("totalPay", "pay", "totalCost")),
        }
    return out


def _shift_tag_names(shift: dict) -> list:
    """Shift tag labels (e.g. "Rate Pay") off a scheduler shift, defensively —
    Connecteam exposes these under a few shapes (list of strings, list of
    {name}/{title}/{label} objects). Used to auto-flag piece-rate shifts."""
    raw = shift.get("tags") or shift.get("shiftTags") or shift.get("labels") or []
    out = []
    for t in raw:
        if isinstance(t, str):
            out.append(t)
        elif isinstance(t, dict):
            name = t.get("name") or t.get("title") or t.get("label")
            if name:
                out.append(str(name))
    return out


async def get_scheduled_shifts(start_date: str, end_date: str,
                               scheduler_id: Optional[str] = None) -> list:
    """List published + open shifts in the window from the scheduler, as flat
    normalized rows for the Schedule tab. Dates are YYYY-MM-DD; Connecteam wants
    epoch seconds, so we convert to [00:00 start_date, 23:59:59 end_date]."""
    sched = scheduler_id or _get_scheduler_id()
    if not sched:
        raise ConnecteamAuthError(
            "No Connecteam scheduler configured — set the Scheduler ID in "
            "Settings → Integrations."
        )
    start_epoch = _to_epoch_seconds(f"{start_date}T00:00:00")
    end_epoch = _to_epoch_seconds(f"{end_date}T23:59:59")
    params: dict = {"startTime": start_epoch, "endTime": end_epoch,
                    "limit": 500, "offset": 0}
    rows: list = []
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            r = await client.get(
                f"{CONNECTEAM_BASE}/scheduler/v1/schedulers/{sched}/shifts",
                headers=_headers(), params=params,
            )
            _raise_for_status(r)
            data = r.json()
            shifts = ((data.get("data") or {}).get("shifts")) or data.get("shifts") or []
            for s in shifts:
                loc = s.get("locationData") or {}
                rows.append({
                    "id": str(s.get("id") or ""),
                    "title": s.get("title") or "",
                    "startTimestamp": s.get("startTime"),
                    "endTimestamp": s.get("endTime"),
                    "assignedUserIds": s.get("assignedUserIds") or [],
                    "jobId": str(s.get("jobId")) if s.get("jobId") is not None else None,
                    "address": loc.get("address") or "",
                    "isOpenShift": bool(s.get("isOpenShift")),
                    "isPublished": bool(s.get("isPublished")),
                    "tags": _shift_tag_names(s),
                })
            if len(shifts) < params["limit"]:
                break
            params["offset"] += params["limit"]
    return rows


async def get_team() -> list:
    """Everyone in Connecteam, normalized for the Team directory: name, phone,
    email, role/type, archived flag. Reads /users/v1/users (already used by the
    Settings test), just reshaped."""
    users = await get_employees()
    out: list = []
    for u in users or []:
        uid = u.get("userId") if u.get("userId") is not None else u.get("id")
        if uid is None:
            continue
        name = " ".join(x for x in [u.get("firstName"), u.get("lastName")] if x).strip()
        out.append({
            "id": str(uid),
            "name": name or u.get("name") or u.get("email") or str(uid),
            "email": u.get("email") or "",
            "phone": u.get("phoneNumber") or u.get("phone") or "",
            "role": u.get("userType") or u.get("role") or u.get("title") or "",
            "archived": bool(u.get("isArchived")),
        })
    out.sort(key=lambda e: e["name"].lower())
    return out


async def get_pay_rates(start_date: str, end_date: str) -> dict:
    """{ userId(str) → {"rate": float, "type": str, "currency": str} } from
    Connecteam's Pay Rates API. Best-effort and defensively parsed — the
    response field names aren't pinned in the public docs, so we probe several
    common keys and skip anything we can't read as a number. Empty dict when
    the account doesn't expose pay rates (the feature is plan-gated)."""
    params: dict = {"startDate": start_date, "endDate": end_date,
                    "rateType": "hourly", "limit": 500, "offset": 0}
    out: dict = {}
    async with httpx.AsyncClient(timeout=20) as client:
        while True:
            r = await client.get(f"{CONNECTEAM_BASE}/pay-rates/v1/pay-rates",
                                 headers=_headers(), params=params)
            _raise_for_status(r)
            data = r.json()
            items = ((data.get("data") or {}).get("payRates")) \
                or data.get("payRates") or (data.get("data") if isinstance(data.get("data"), list) else []) or []
            for it in items:
                uid = it.get("userId") if it.get("userId") is not None else it.get("id")
                if uid is None:
                    continue
                raw = None
                for k in ("payRate", "rate", "hourlyRate", "amount", "value", "rateValue"):
                    if it.get(k) is not None:
                        raw = it.get(k)
                        break
                try:
                    rate = float(raw)
                except (TypeError, ValueError):
                    continue
                out[str(uid)] = {
                    "rate": rate,
                    "type": it.get("rateType") or it.get("type") or "hourly",
                    "currency": it.get("currency") or "USD",
                }
            if len(items) < params["limit"]:
                break
            params["offset"] += params["limit"]
    return out


def _employee_name_map(employees: list) -> dict:
    """{ userId(str) → display name } from the /users list, so timesheet rows
    show real names instead of numeric ids."""
    out: dict = {}
    for e in employees or []:
        uid = e.get("userId") if e.get("userId") is not None else e.get("id")
        if uid is None:
            continue
        name = " ".join(x for x in [e.get("firstName"), e.get("lastName")] if x).strip()
        out[str(uid)] = name or e.get("name") or e.get("email") or str(uid)
    return out


async def get_timesheets(start_date: str, end_date: str,
                         employee_id: Optional[str] = None) -> list:
    """Back-compat shape for the legacy /api/payroll/timesheets endpoint: a
    flat list of per-shift entries with durationMinutes/userId/userName. New
    code should use get_time_activities (richer) + the /summary endpoint."""
    rows = await get_time_activities(start_date, end_date, employee_id=employee_id)
    try:
        names = _employee_name_map(await get_employees())
    except Exception:
        names = {}
    for r in rows:
        r["durationMinutes"] = r["netMinutes"]
        r["userName"] = names.get(str(r["userId"]), str(r["userId"]))
    return rows


async def get_mileage(start_date: str, end_date: str,
                      employee_id: Optional[str] = None) -> list:
    """Back-compat shape for the legacy /api/payroll/mileage endpoint: one row
    per shift that carries mileage, with distance/userId/userName."""
    rows = await get_time_activities(start_date, end_date, employee_id=employee_id)
    try:
        names = _employee_name_map(await get_employees())
    except Exception:
        names = {}
    out = []
    for r in rows:
        if r["miles"] <= 0:
            continue
        out.append({
            "userId": r["userId"],
            "userName": names.get(str(r["userId"]), str(r["userId"])),
            "distance": r["miles"],
            "startTimestamp": r["startTimestamp"],
        })
    return out
