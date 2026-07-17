"""Connecteam data hub — read-only pass-throughs of Connecteam data for the
Connecteam page (Team, Jobs, Schedule, detailed Timesheets, Pay rates).

Everything here is a thin, defensively-parsed read: if Connecteam is down or a
product module isn't on the account's plan, the endpoint returns an empty list
(or a 503 for an auth failure) rather than crashing the page. All routes are
admin/manager gated.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from integrations.connecteam import (
    ConnecteamAuthError,
    get_team,
    get_jobs,
    get_scheduled_shifts,
    get_time_activities,
    get_pay_rates,
    get_employees,
    _employee_name_map,
)
from modules.auth.router import require_role

router = APIRouter()


def _err(e: Exception):
    if isinstance(e, ConnecteamAuthError):
        return HTTPException(status_code=503, detail=str(e))
    return HTTPException(status_code=502, detail=f"Connecteam error: {e}")


@router.get("/team", dependencies=[Depends(require_role("admin", "manager"))])
async def team():
    """Everyone in Connecteam: name, phone, email, role, archived flag."""
    try:
        return {"members": await get_team()}
    except Exception as e:
        raise _err(e)


@router.get("/jobs", dependencies=[Depends(require_role("admin", "manager"))])
async def jobs():
    """All Connecteam jobs (what crew clock into), with names + codes."""
    try:
        jmap = await get_jobs()
    except Exception as e:
        raise _err(e)
    out = [{"id": jid, "name": v["name"], "code": v["code"]} for jid, v in jmap.items()]
    out.sort(key=lambda j: j["name"].lower())
    return {"jobs": out}


@router.get("/schedule", dependencies=[Depends(require_role("admin", "manager"))])
async def schedule(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
):
    """Scheduled shifts in the window, with assigned crew + job names resolved."""
    try:
        shifts = await get_scheduled_shifts(start_date, end_date)
    except Exception as e:
        raise _err(e)
    # Best-effort name resolution — never fail the list if a lookup errors.
    try:
        names = _employee_name_map(await get_employees())
    except Exception:
        names = {}
    try:
        jobs_map = await get_jobs()
    except Exception:
        jobs_map = {}
    for s in shifts:
        s["assigned_names"] = [names.get(str(uid), str(uid)) for uid in s.get("assignedUserIds", [])]
        s["job_name"] = (jobs_map.get(str(s["jobId"])) or {}).get("name") if s.get("jobId") else None
    return {"period": f"{start_date} to {end_date}", "shifts": shifts}


@router.get("/timesheets-detailed", dependencies=[Depends(require_role("admin", "manager"))])
async def timesheets_detailed(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    employee_id: Optional[str] = None,
):
    """Every punch in the window with full detail: clock in/out, hours, breaks,
    job, clock-in/out location, notes, mileage — grouped per crew member."""
    try:
        rows = await get_time_activities(start_date, end_date, employee_id=employee_id)
    except Exception as e:
        raise _err(e)
    try:
        names = _employee_name_map(await get_employees())
    except Exception:
        names = {}
    try:
        jobs_map = await get_jobs()
    except Exception:
        jobs_map = {}

    people: dict = {}
    for r in rows:
        uid = str(r["userId"])
        p = people.get(uid)
        if p is None:
            p = {"employee_id": uid, "name": names.get(uid, uid), "total_hours": 0.0, "shifts": []}
            people[uid] = p
        p["total_hours"] = round(p["total_hours"] + r["netHours"], 2)
        p["shifts"].append({
            "shift_id": r["shiftId"],
            "start": r["startTimestamp"],
            "end": r["endTimestamp"],
            "timezone": r["timezone"],
            "hours": round(r["netHours"], 2),
            "breaks_minutes": r["breaksMinutes"],
            "job": (jobs_map.get(str(r["jobId"])) or {}).get("name") if r["jobId"] else None,
            "start_location": r["startLocation"],
            "end_location": r["endLocation"],
            "note": r["employeeNote"],
            "manager_note": r["managerNote"],
            "miles": r["miles"],
            "auto_clock_out": r["isAutoClockOut"],
        })
    out = sorted(people.values(), key=lambda p: str(p["name"]).lower())
    return {"period": f"{start_date} to {end_date}", "employees": out}


@router.get("/pay-rates", dependencies=[Depends(require_role("admin", "manager"))])
async def pay_rates(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
):
    """Connecteam's stored per-person pay rates (empty if the plan doesn't
    expose them). Keyed by userId so the Payroll page can show them alongside
    its own editable rates."""
    try:
        return {"rates": await get_pay_rates(start_date, end_date)}
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception:
        # Pay Rates is plan-gated; a failure here shouldn't look like an outage.
        return {"rates": {}}
