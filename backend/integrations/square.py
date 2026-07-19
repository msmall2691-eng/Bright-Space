"""Square integration — push payroll hours into Square as Labor API Timecards.

Square Payroll has no public "run a pay run" API; the supported path is the
Labor API: create Timecards (hours worked per team member per shift) and the
operator imports them in the Square Payroll dashboard. This module is a thin,
defensively-parsed client for the pieces we need:

  * Verify / locations:  GET  /v2/locations
  * Team directory:      POST /v2/team-members/search   (id, name, email → match)
  * Create timecard:     POST /v2/labor/timecards       (Square-Version header)

Auth is a Square **access token** the operator pastes into BrightBase Settings
(server-to-server) — NOT the claude.ai Square connector. Money is in cents.

Docs: https://developer.squareup.com/reference/square/labor-api/create-timecard
"""
import os
import httpx
from datetime import datetime, timezone
from typing import Optional

# Square keeps the Labor/Team APIs versioned via a header; pin a known-good one.
SQUARE_VERSION = "2026-07-15"

_PROD_BASE = "https://connect.squareup.com"
_SANDBOX_BASE = "https://connect.squareupsandbox.com"


def _db_setting(key: str) -> str:
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


def _get_token() -> str:
    return _db_setting("square_access_token") or os.getenv("SQUARE_ACCESS_TOKEN", "").strip()


def _get_location() -> str:
    return _db_setting("square_location_id") or os.getenv("SQUARE_LOCATION_ID", "").strip()


def _get_environment() -> str:
    return (_db_setting("square_environment") or os.getenv("SQUARE_ENVIRONMENT", "production")).strip().lower()


def _base_url() -> str:
    return _SANDBOX_BASE if _get_environment() == "sandbox" else _PROD_BASE


def is_configured() -> bool:
    """True when a token + location are present — lets callers tell 'not
    connected' apart from 'connected but the call failed'."""
    return bool(_get_token() and _get_location())


def has_token() -> bool:
    return bool(_get_token())


class SquareAuthError(Exception):
    """Square rejected the token (401/403). Callers surface 'rotate your Square
    access token' guidance, distinct from a transient 5xx."""


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_get_token()}",
        "Square-Version": SQUARE_VERSION,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _raise_for_status(r: httpx.Response) -> None:
    if r.status_code in (401, 403):
        raise SquareAuthError("Square rejected the access token — rotate it in Settings.")
    r.raise_for_status()


def _err_detail(r: httpx.Response) -> str:
    """Square returns {"errors":[{"detail": "..."}]} — pull the first message
    so failures are legible instead of a bare status code."""
    try:
        errs = r.json().get("errors") or []
        if errs:
            return errs[0].get("detail") or errs[0].get("code") or r.text[:200]
    except Exception:
        pass
    return f"HTTP {r.status_code}"


def dollars_to_cents(amount) -> int:
    try:
        return int(round(float(amount) * 100))
    except (TypeError, ValueError):
        return 0


def _iso(ts: int) -> str:
    """Epoch seconds → RFC 3339 the Square API accepts."""
    return datetime.fromtimestamp(int(ts), timezone.utc).isoformat()


# ─── Reads ─────────────────────────────────────────────────────────────────

async def list_locations() -> list:
    """[{id, name}] of the account's Square locations, for the Settings picker."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{_base_url()}/v2/locations", headers=_headers())
        _raise_for_status(r)
        data = r.json()
    return [{"id": l.get("id"), "name": l.get("name") or l.get("id")}
            for l in (data.get("locations") or []) if l.get("id")]


async def list_team_members(location_id: Optional[str] = None) -> list:
    """Active Square team members as [{id, name, email}] for matching against
    Connecteam users. Filters to the configured location when given."""
    body: dict = {"query": {"filter": {"status": "ACTIVE"}}, "limit": 200}
    loc = location_id or _get_location()
    if loc:
        body["query"]["filter"]["location_ids"] = {"any": [loc]}
    out: list = []
    async with httpx.AsyncClient(timeout=20) as client:
        cursor = None
        while True:
            if cursor:
                body["cursor"] = cursor
            r = await client.post(f"{_base_url()}/v2/team-members/search",
                                 headers=_headers(), json=body)
            _raise_for_status(r)
            data = r.json()
            for m in (data.get("team_members") or []):
                if not m.get("id"):
                    continue
                name = " ".join(x for x in [m.get("given_name"), m.get("family_name")] if x).strip()
                out.append({
                    "id": m["id"],
                    "name": name or m.get("email_address") or m["id"],
                    "email": (m.get("email_address") or "").strip().lower(),
                })
            cursor = data.get("cursor")
            if not cursor:
                break
    return out


async def verify() -> dict:
    """Auth smoke test for the Settings 'Test connection' button: confirm the
    token works and return locations + a team-member count."""
    locations = await list_locations()
    try:
        team = await list_team_members()
    except Exception:
        team = []
    return {"ok": True, "locations": locations, "team_count": len(team)}


# ─── Writes ────────────────────────────────────────────────────────────────

async def create_timecard(*, team_member_id: str, start_ts: int, end_ts: int,
                          hourly_rate_cents: int, title: str,
                          idempotency_key: str, location_id: Optional[str] = None,
                          timezone_name: Optional[str] = None) -> dict:
    """Create one Square Timecard. Returns {"ok": bool, "id"|"error"}.
    Idempotency key makes re-sends safe (Square dedupes)."""
    loc = location_id or _get_location()
    timecard: dict = {
        "team_member_id": str(team_member_id),
        "location_id": loc,
        "start_at": _iso(start_ts),
        "end_at": _iso(end_ts),
        "wage": {
            "title": title[:255] if title else "Cleaning",
            "hourly_rate": {"amount": int(hourly_rate_cents), "currency": "USD"},
        },
    }
    if timezone_name:
        timecard["timezone"] = timezone_name
    body = {"idempotency_key": idempotency_key[:128], "timecard": timecard}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(f"{_base_url()}/v2/labor/timecards",
                             headers=_headers(), json=body)
        if r.status_code in (401, 403):
            raise SquareAuthError("Square rejected the access token — rotate it in Settings.")
        if r.status_code >= 400:
            return {"ok": False, "error": _err_detail(r)}
        data = r.json()
    tc = data.get("timecard") or {}
    return {"ok": True, "id": tc.get("id")}
