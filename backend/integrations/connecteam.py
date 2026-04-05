"""
Connecteam API integration.
Docs: https://developer.connecteam.com/
"""

import os
import httpx
from typing import Optional

CONNECTEAM_BASE = "https://api.connecteam.com/v1"


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {os.getenv('CONNECTEAM_API_KEY', '')}",
        "Content-Type": "application/json",
    }


def _company_id() -> str:
    return os.getenv("CONNECTEAM_COMPANY_ID", "")


async def get_employees() -> list:
    """Fetch all employees from Connecteam."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{CONNECTEAM_BASE}/companies/{_company_id()}/users",
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json().get("users", [])


async def create_shift(
    employee_id: str,
    start_datetime: str,   # ISO 8601: 2025-04-10T08:00:00
    end_datetime: str,
    title: str,
    address: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """Create a single shift in Connecteam for one employee."""
    payload = {
        "userId": employee_id,
        "startTime": start_datetime,
        "endTime": end_datetime,
        "title": title,
    }
    if address:
        payload["location"] = address
    if notes:
        payload["notes"] = notes

    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{CONNECTEAM_BASE}/companies/{_company_id()}/shifts",
            headers=_headers(),
            json=payload,
        )
        r.raise_for_status()
        return r.json()


async def delete_shift(shift_id: str) -> None:
    """Delete a shift from Connecteam."""
    async with httpx.AsyncClient() as client:
        r = await client.delete(
            f"{CONNECTEAM_BASE}/companies/{_company_id()}/shifts/{shift_id}",
            headers=_headers(),
        )
        r.raise_for_status()


async def get_timesheets(
    start_date: str,   # YYYY-MM-DD
    end_date: str,
    employee_id: Optional[str] = None,
) -> list:
    """Fetch timesheet entries from Connecteam for a date range."""
    params = {
        "startDate": start_date,
        "endDate": end_date,
        "companyId": _company_id(),
    }
    if employee_id:
        params["userId"] = employee_id

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{CONNECTEAM_BASE}/timesheets",
            headers=_headers(),
            params=params,
        )
        r.raise_for_status()
        return r.json().get("timesheets", [])


async def get_mileage(
    start_date: str,
    end_date: str,
    employee_id: Optional[str] = None,
) -> list:
    """Fetch mileage entries from Connecteam for a date range."""
    params = {
        "startDate": start_date,
        "endDate": end_date,
        "companyId": _company_id(),
    }
    if employee_id:
        params["userId"] = employee_id

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{CONNECTEAM_BASE}/mileage",
            headers=_headers(),
            params=params,
        )
        r.raise_for_status()
        return r.json().get("entries", [])
