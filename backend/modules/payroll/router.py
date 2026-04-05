from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from integrations.connecteam import get_timesheets, get_mileage

router = APIRouter()

MILEAGE_RATE = 0.67  # IRS standard mileage rate per mile


@router.get("/timesheets")
async def fetch_timesheets(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    employee_id: Optional[str] = None,
):
    """Pull timesheet data from Connecteam for a pay period."""
    try:
        sheets = await get_timesheets(start_date, end_date, employee_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")

    # Summarize hours per employee
    summary: dict = {}
    for entry in sheets:
        uid = entry.get("userId", "unknown")
        hours = entry.get("durationMinutes", 0) / 60
        if uid not in summary:
            summary[uid] = {"employee_id": uid, "name": entry.get("userName", uid), "total_hours": 0, "entries": []}
        summary[uid]["total_hours"] += hours
        summary[uid]["entries"].append(entry)

    return {"period": f"{start_date} to {end_date}", "employees": list(summary.values())}


@router.get("/mileage")
async def fetch_mileage(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    employee_id: Optional[str] = None,
    rate: float = Query(MILEAGE_RATE, description="Reimbursement rate per mile"),
):
    """Pull mileage data from Connecteam and calculate reimbursements."""
    try:
        entries = await get_mileage(start_date, end_date, employee_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")

    summary: dict = {}
    for entry in entries:
        uid = entry.get("userId", "unknown")
        miles = entry.get("distance", 0)
        if uid not in summary:
            summary[uid] = {
                "employee_id": uid,
                "name": entry.get("userName", uid),
                "total_miles": 0,
                "reimbursement": 0,
                "entries": [],
            }
        summary[uid]["total_miles"] += miles
        summary[uid]["entries"].append(entry)

    for emp in summary.values():
        emp["reimbursement"] = round(emp["total_miles"] * rate, 2)

    return {
        "period": f"{start_date} to {end_date}",
        "rate_per_mile": rate,
        "employees": list(summary.values()),
    }
