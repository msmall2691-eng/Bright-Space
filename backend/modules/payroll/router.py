"""Payroll — turn Connecteam Time Clock punches into a payroll-ready breakdown.

The page this feeds answers one question for a pay period: for each crew member,
how many hours on residential cleans vs rental turnovers, how many weekend
turnovers, and what do we owe them? Pay rules (operator-editable in Settings /
on the page):

  * Residential hours (any day) ........ $/hr  (pay_rate_residential, default 25)
  * Rental hours on a WEEKDAY .......... $/hr  (pay_rate_rental_weekday, default 26)
  * Rental turnover on a WEEKEND ....... piece rate per turnover, set per-property
                                         (Property.turnover_rate)
  * Mileage ............................ miles * mileage_rate (default IRS 0.67)

Classification of a punch as residential vs rental is authoritative when the
punch links back to a CRM-scheduled job (schedulerShiftId → Job.connecteam_shift_ids
→ Job.job_type + property). When it doesn't, we fall back to the Connecteam job
name. Punches we can't classify at all are surfaced separately, never silently
folded into a paid bucket.
"""
from datetime import datetime, date, timedelta, timezone as _tz
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel

from database.db import get_db
from database.models import Job, Property
from integrations.connecteam import (
    ConnecteamAuthError,
    get_timesheets,
    get_mileage,
    get_time_activities,
    get_employees,
    get_jobs,
    get_timesheet_totals,
    _employee_name_map,
)
from modules.auth.router import require_role
from modules.settings.router import get_setting, set_setting

try:  # stdlib on 3.9+, but guard so import never takes the app down
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

router = APIRouter()

MILEAGE_RATE = 0.67  # IRS standard mileage rate per mile (default)
DEFAULT_RESIDENTIAL_RATE = 25.0
DEFAULT_RENTAL_WEEKDAY_RATE = 26.0

# Connecteam job-name keywords that mean "short-term rental turnover" when a
# punch isn't linked to a CRM job. Deliberately broad — better to catch a
# rental than misfile it as residential.
_RENTAL_KEYWORDS = ("turnover", "rental", "str ", "str-", "airbnb", "vrbo",
                    "bnb", "guest", "short term", "short-term", "vacation")


def _rate(db: Session, key: str, default: float) -> float:
    raw = get_setting(db, key)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _get_rates(db: Session) -> dict:
    return {
        "residential_rate": _rate(db, "pay_rate_residential", DEFAULT_RESIDENTIAL_RATE),
        "rental_weekday_rate": _rate(db, "pay_rate_rental_weekday", DEFAULT_RENTAL_WEEKDAY_RATE),
        "mileage_rate": _rate(db, "mileage_rate", MILEAGE_RATE),
    }


def _local_date(timestamp: int, tz_name: str) -> date:
    """The calendar date a punch happened in the *shift's* timezone — which is
    what decides weekday vs weekend. Falls back to UTC when the tz is missing
    or unknown (rare; only matters for punches straddling local midnight)."""
    tz = None
    if tz_name and ZoneInfo is not None:
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = None
    dt = datetime.fromtimestamp(timestamp, tz or _tz.utc)
    return dt.date()


def _is_weekend(d: date) -> bool:
    return d.weekday() >= 5  # Sat=5, Sun=6


def _classify_name(name: str) -> str:
    low = (name or "").lower()
    return "rental" if any(k in low for k in _RENTAL_KEYWORDS) else "residential"


def _crm_shift_index(db: Session, start_date: str, end_date: str) -> dict:
    """{ connecteam_shift_id → Job } for jobs scheduled in (or near) the window
    that were pushed to Connecteam. Lets a time-clock punch's schedulerShiftId
    resolve to the authoritative CRM job (type + property). The ±1 day padding
    absorbs timezone edges around the period boundary."""
    try:
        lo = datetime.strptime(start_date, "%Y-%m-%d").date() - timedelta(days=1)
        hi = datetime.strptime(end_date, "%Y-%m-%d").date() + timedelta(days=1)
    except ValueError:
        return {}
    jobs = (
        db.query(Job)
        .options(joinedload(Job.property))
        .filter(Job.scheduled_date >= lo, Job.scheduled_date <= hi)
        .all()
    )
    index: dict = {}
    for j in jobs:
        for sid in (j.connecteam_shift_ids or []):
            index[str(sid)] = j
    return index


@router.get("/rates", dependencies=[Depends(require_role("admin", "manager"))])
def get_pay_rates(db: Session = Depends(get_db)):
    """Current pay rates so the Payroll page can show + edit them."""
    return _get_rates(db)


class PayRates(BaseModel):
    residential_rate: Optional[float] = None
    rental_weekday_rate: Optional[float] = None
    mileage_rate: Optional[float] = None


@router.put("/rates", dependencies=[Depends(require_role("admin"))])
def update_pay_rates(rates: PayRates, db: Session = Depends(get_db)):
    """Persist edited pay rates. Only provided fields change."""
    mapping = {
        "residential_rate": "pay_rate_residential",
        "rental_weekday_rate": "pay_rate_rental_weekday",
        "mileage_rate": "mileage_rate",
    }
    for field, key in mapping.items():
        val = getattr(rates, field)
        if val is not None:
            if val < 0:
                raise HTTPException(status_code=422, detail=f"{field} cannot be negative")
            set_setting(db, key, str(float(val)))
    db.commit()
    return _get_rates(db)


def _blank_emp(uid, name) -> dict:
    return {
        "employee_id": uid,
        "name": name,
        "total_hours": 0.0,          # authoritative: Connecteam's if available
        "computed_hours": 0.0,       # our punch-summed total (for reconciliation)
        "connecteam_hours": None,    # Connecteam's official timesheet total
        "hours_source": "computed",  # "connecteam" | "computed"
        "unallocated_hours": 0.0,    # Connecteam total minus classified buckets
        "residential_hours": 0.0,
        "residential_pay": 0.0,
        "rental_weekday_hours": 0.0,
        "rental_weekday_pay": 0.0,
        "weekend_rental_hours": 0.0,
        "weekend_turnovers": 0,
        "weekend_pay": 0.0,
        "weekend_unpriced_turnovers": 0,
        "unclassified_hours": 0.0,
        "miles": 0.0,
        "mileage_reimbursement": 0.0,
        "gross_pay": 0.0,
        "shifts": [],
        # internal: (property_id or name) → set of local dates, to count a
        # crew member's distinct weekend turnovers per property
        "_weekend_seen": {},
        "_weekend_rate": {},
    }


@router.get("/summary", dependencies=[Depends(require_role("admin", "manager"))])
async def payroll_summary(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    db: Session = Depends(get_db),
):
    """The payroll-ready breakdown for a pay period: per-crew hours split into
    residential / rental-weekday / weekend-turnover buckets, mileage, and a
    computed gross. This is the endpoint the Payroll page runs on."""
    # Guard the 92-day Connecteam window early with a friendly message.
    try:
        d0 = datetime.strptime(start_date, "%Y-%m-%d").date()
        d1 = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD")
    if d1 < d0:
        raise HTTPException(status_code=422, detail="End date is before start date")
    if (d1 - d0).days > 92:
        raise HTTPException(status_code=422, detail="Connecteam allows at most a 92-day range")

    rates = _get_rates(db)
    try:
        rows = await get_time_activities(start_date, end_date)
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")

    # Best-effort enrichers — never fail the whole pull if one is unavailable.
    try:
        names = _employee_name_map(await get_employees())
    except Exception:
        names = {}
    try:
        ct_jobs = await get_jobs()
    except Exception:
        ct_jobs = {}
    # Connecteam's own official total hours (their rounding/break rules applied)
    # so the headline number reconciles to Connecteam exactly. Capped at 45 days
    # by Connecteam; skip (fall back to punch-summed) for longer ranges.
    official_totals: dict = {}
    if (d1 - d0).days <= 45:
        try:
            official_totals = await get_timesheet_totals(start_date, end_date)
        except Exception:
            official_totals = {}
    crm_index = _crm_shift_index(db, start_date, end_date)

    employees: dict = {}
    warnings: list = []
    unclassified_shifts = 0

    for r in rows:
        uid = str(r["userId"])
        emp = employees.get(uid)
        if emp is None:
            emp = _blank_emp(uid, names.get(uid, uid))
            employees[uid] = emp

        hours = r["netHours"]
        emp["computed_hours"] += hours
        emp["miles"] += r["miles"]

        d = _local_date(r["startTimestamp"], r["timezone"])
        weekend = _is_weekend(d)

        # ── Classify: CRM job (authoritative) → Connecteam job name → unknown
        kind = None
        prop = None
        source = "unlinked"
        crm_job = crm_index.get(r["schedulerShiftId"]) if r["schedulerShiftId"] else None
        if crm_job is not None:
            kind = "rental" if crm_job.job_type == "str_turnover" else "residential"
            prop = crm_job.property
            source = "crm"
        elif r["jobId"] and str(r["jobId"]) in ct_jobs:
            kind = _classify_name(ct_jobs[str(r["jobId"])]["name"])
            source = "job_name"
        elif r["jobId"]:
            kind = _classify_name(str(r["jobId"]))
            source = "job_name"

        detail = {
            "shift_id": r["shiftId"],
            "date": d.isoformat(),
            "weekend": weekend,
            "hours": round(hours, 2),
            "miles": r["miles"],
            "kind": kind or "unclassified",
            "source": source,
            "property": prop.name if prop is not None else None,
            "note": r["employeeNote"],
            "pay": 0.0,
        }

        if kind is None:
            emp["unclassified_hours"] += hours
            unclassified_shifts += 1
            emp["shifts"].append(detail)
            continue

        if kind == "residential":
            emp["residential_hours"] += hours
            pay = hours * rates["residential_rate"]
            emp["residential_pay"] += pay
            detail["pay"] = round(pay, 2)
        elif kind == "rental" and not weekend:
            emp["rental_weekday_hours"] += hours
            pay = hours * rates["rental_weekday_rate"]
            emp["rental_weekday_pay"] += pay
            detail["pay"] = round(pay, 2)
        else:  # rental + weekend → piece rate
            emp["weekend_rental_hours"] += hours
            # A crew member's distinct turnover = one (property, local date).
            key = (prop.id if prop is not None else f"name:{detail['property'] or r['jobId']}")
            seen = emp["_weekend_seen"].setdefault(key, set())
            first_today = d.isoformat() not in seen
            seen.add(d.isoformat())
            if first_today:
                emp["weekend_turnovers"] += 1
                rate = getattr(prop, "turnover_rate", None) if prop is not None else None
                if rate is None:
                    emp["weekend_unpriced_turnovers"] += 1
                    pname = detail["property"] or f"Connecteam job {r['jobId']}"
                    warnings.append(
                        f"{emp['name']}: weekend turnover at {pname} on {d.isoformat()} "
                        f"has no piece rate set — not included in pay."
                    )
                else:
                    emp["weekend_pay"] += float(rate)
                    detail["pay"] = round(float(rate), 2)
        emp["shifts"].append(detail)

    # Finalize: reconcile to Connecteam's official total, mileage, gross.
    out_emps = []
    for emp in employees.values():
        emp["computed_hours"] = round(emp["computed_hours"], 2)
        official = official_totals.get(str(emp["employee_id"]))
        if official is not None:
            emp["connecteam_hours"] = official["hours"]
            emp["total_hours"] = official["hours"]
            emp["hours_source"] = "connecteam"
        else:
            emp["total_hours"] = emp["computed_hours"]
        # Classified + unclassified hours we could account for from punches.
        accounted = (emp["residential_hours"] + emp["rental_weekday_hours"]
                     + emp["weekend_rental_hours"] + emp["unclassified_hours"])
        emp["unallocated_hours"] = round(emp["total_hours"] - accounted, 2)

        emp["mileage_reimbursement"] = round(emp["miles"] * rates["mileage_rate"], 2)
        emp["gross_pay"] = round(
            emp["residential_pay"] + emp["rental_weekday_pay"]
            + emp["weekend_pay"] + emp["mileage_reimbursement"], 2
        )
        for k in ("total_hours", "residential_hours", "residential_pay",
                  "rental_weekday_hours", "rental_weekday_pay",
                  "weekend_rental_hours", "weekend_pay",
                  "unclassified_hours", "miles"):
            emp[k] = round(emp[k], 2)
        emp.pop("_weekend_seen", None)
        emp.pop("_weekend_rate", None)
        out_emps.append(emp)

    out_emps.sort(key=lambda e: e["name"].lower() if isinstance(e["name"], str) else str(e["name"]))

    totals = {
        "total_hours": round(sum(e["total_hours"] for e in out_emps), 2),
        "computed_hours": round(sum(e["computed_hours"] for e in out_emps), 2),
        "unallocated_hours": round(sum(e["unallocated_hours"] for e in out_emps), 2),
        "residential_hours": round(sum(e["residential_hours"] for e in out_emps), 2),
        "rental_weekday_hours": round(sum(e["rental_weekday_hours"] for e in out_emps), 2),
        "weekend_rental_hours": round(sum(e["weekend_rental_hours"] for e in out_emps), 2),
        "weekend_turnovers": sum(e["weekend_turnovers"] for e in out_emps),
        "unclassified_hours": round(sum(e["unclassified_hours"] for e in out_emps), 2),
        "miles": round(sum(e["miles"] for e in out_emps), 2),
        "mileage_reimbursement": round(sum(e["mileage_reimbursement"] for e in out_emps), 2),
        "gross_pay": round(sum(e["gross_pay"] for e in out_emps), 2),
    }

    if unclassified_shifts:
        warnings.insert(0, (
            f"{unclassified_shifts} punch(es) weren't tied to a job in Connecteam, "
            f"so they couldn't be split into residential vs rental. Their hours are "
            f"listed as 'unclassified' and left out of pay."
        ))

    hours_source = "connecteam" if official_totals else "computed"
    if hours_source == "computed" and (d1 - d0).days <= 45:
        warnings.append(
            "Couldn't read Connecteam's official timesheet totals for this period "
            "— hours shown are computed from raw punches and may differ slightly "
            "from Connecteam's rounded totals."
        )

    return {
        "period": f"{start_date} to {end_date}",
        "start_date": start_date,
        "end_date": end_date,
        "rates": rates,
        "hours_source": hours_source,
        "employees": out_emps,
        "totals": totals,
        "warnings": warnings,
    }


@router.get("/timesheets", dependencies=[Depends(require_role("admin"))])
async def fetch_timesheets(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    employee_id: Optional[str] = None,
):
    """Legacy raw timesheet pull (kept for back-compat). New UI uses /summary."""
    try:
        sheets = await get_timesheets(start_date, end_date, employee_id)
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {str(e)}")

    summary: dict = {}
    for entry in sheets:
        uid = entry.get("userId", "unknown")
        hours = entry.get("durationMinutes", 0) / 60
        if uid not in summary:
            summary[uid] = {"employee_id": uid, "name": entry.get("userName", uid), "total_hours": 0, "entries": []}
        summary[uid]["total_hours"] += hours
        summary[uid]["entries"].append(entry)

    return {"period": f"{start_date} to {end_date}", "employees": list(summary.values())}


@router.get("/mileage", dependencies=[Depends(require_role("admin", "manager"))])
async def fetch_mileage(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    employee_id: Optional[str] = None,
    rate: float = Query(MILEAGE_RATE, description="Reimbursement rate per mile"),
):
    """Legacy mileage pull (kept for back-compat). New UI uses /summary."""
    try:
        entries = await get_mileage(start_date, end_date, employee_id)
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
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
