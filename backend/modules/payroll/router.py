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
from datetime import datetime, date, time, timedelta, timezone as _tz
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel

from database.db import get_db
from database.models import Job, Property, TimeEntry, User
from utils.dates import business_tz
from integrations.connecteam import (
    ConnecteamAuthError,
    get_timesheets,
    get_mileage,
    get_time_activities,
    get_employees,
    get_jobs,
    get_timesheet_totals,
    get_scheduled_shifts,
    get_team,
    _employee_name_map,
)
from modules.auth.router import require_role, current_org_id, resolve_org_id
from modules.settings.router import get_setting, set_setting

try:  # stdlib on 3.9+, but guard so import never takes the app down
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

router = APIRouter()

MILEAGE_RATE = 0.67  # IRS standard mileage rate per mile (default)
DEFAULT_RESIDENTIAL_RATE = 25.0
DEFAULT_RENTAL_WEEKDAY_RATE = 26.0
# Deep cleans default to the residential rate until the shop sets a (higher)
# deep rate in Settings — so an unconfigured deep clean never pays LESS than a
# regular clean; the premium is opt-in.
DEFAULT_DEEP_CLEAN_RATE = DEFAULT_RESIDENTIAL_RATE

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
        "deep_clean_rate": _rate(db, "pay_rate_deep_clean", DEFAULT_DEEP_CLEAN_RATE),
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
    deep_clean_rate: Optional[float] = None
    mileage_rate: Optional[float] = None


@router.put("/rates", dependencies=[Depends(require_role("admin"))])
def update_pay_rates(rates: PayRates, db: Session = Depends(get_db)):
    """Persist edited pay rates. Only provided fields change."""
    mapping = {
        "residential_rate": "pay_rate_residential",
        "rental_weekday_rate": "pay_rate_rental_weekday",
        "deep_clean_rate": "pay_rate_deep_clean",
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


def _payroll_source(db: Session) -> str:
    return (get_setting(db, "payroll_source") or "connecteam").strip().lower()


@router.get("/source", dependencies=[Depends(require_role("admin", "manager"))])
def get_payroll_source(db: Session = Depends(get_db)):
    """Which time source payroll reads: 'connecteam' (default) or 'native'."""
    return {"source": _payroll_source(db)}


class PayrollSourceBody(BaseModel):
    source: str


@router.put("/source", dependencies=[Depends(require_role("admin"))])
def set_payroll_source(body: PayrollSourceBody, db: Session = Depends(get_db)):
    """Switch payroll between Connecteam punches and the native time clock. Kept
    behind this flag so the native source can be dark-tested against Connecteam
    (via Crew Hours reconciliation) and cut over only once the numbers match.
    Default stays 'connecteam' until an admin flips it."""
    src = (body.source or "").strip().lower()
    if src not in ("connecteam", "native"):
        raise HTTPException(status_code=422, detail="source must be 'connecteam' or 'native'")
    set_setting(db, "payroll_source", src)
    db.commit()
    return {"source": src}


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
        "deep_clean_hours": 0.0,     # native only; 0 on the Connecteam path
        "deep_clean_pay": 0.0,
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


# ── Native payroll source (BrightBase time clock, flag-gated) ────────────────

def _native_local_date(dt_utc_naive) -> date:
    """Business-local calendar date of a native punch (stored naive UTC) — what
    decides weekday vs weekend, same as the Connecteam path's shift timezone."""
    return dt_utc_naive.replace(tzinfo=_tz.utc).astimezone(business_tz()).date()


def _native_entry_hours(e) -> float:
    """Worked hours for a native punch: elapsed minus breaks, never negative."""
    if not e.clock_out_at:
        return 0.0
    secs = (e.clock_out_at - e.clock_in_at).total_seconds() - (e.break_minutes or 0) * 60
    return max(0.0, secs) / 3600.0


def _native_summary(db: Session, start_date: str, end_date: str, rates: dict, oid: int) -> dict:
    """The payroll breakdown computed from BrightBase's native time clock
    (time_entries) instead of Connecteam — the SAME response shape as the
    Connecteam path so the Payroll page renders it unchanged.

    Gated behind payroll_source='native' (off by default). Classification comes
    from each punch's linked job (job_type + property): a str_turnover job is
    rental, anything else residential; a punch clocked in with no job is
    'unclassified' and left out of pay, exactly like the Connecteam path's
    unlinked punches. Per-cleaner rate overrides (User.pay_rate_*) apply when
    set, else the global Settings rate. Mileage is the miles a cleaner enters at
    clock-out (TimeEntry.miles) reimbursed at the Settings mileage rate — same as
    the Connecteam path; a punch with no miles entered simply contributes 0."""
    d0 = datetime.strptime(start_date, "%Y-%m-%d").date()
    d1 = datetime.strptime(end_date, "%Y-%m-%d").date()

    # Business-local [d0, d1] inclusive → naive-UTC bounds for the clock-in filter.
    tz = business_tz()
    lo = datetime.combine(d0, time.min, tzinfo=tz).astimezone(_tz.utc).replace(tzinfo=None)
    hi = (datetime.combine(d1, time.min, tzinfo=tz) + timedelta(days=1)).astimezone(_tz.utc).replace(tzinfo=None)

    entries = (
        db.query(TimeEntry)
        .options(joinedload(TimeEntry.job).joinedload(Job.property))
        .filter(or_(TimeEntry.org_id == oid, TimeEntry.org_id.is_(None)),
                TimeEntry.clock_out_at.isnot(None),
                TimeEntry.clock_in_at >= lo,
                TimeEntry.clock_in_at < hi)
        .all()
    )

    cleaner_ids = {e.cleaner_id for e in entries}
    users = {}
    if cleaner_ids:
        # Scope to this org — cleaner_id is intentionally non-unique and `users`
        # isn't an RLS tenant table, so another org's same-id user could
        # otherwise overwrite the map (leaking their name + pay-rate override).
        for u in db.query(User).filter(
            User.cleaner_id.in_(cleaner_ids),
            or_(User.org_id == oid, User.org_id.is_(None)),
        ).all():
            users[u.cleaner_id] = u

    employees: dict = {}
    warnings: list = []
    unclassified_shifts = 0

    for e in entries:
        cid = e.cleaner_id
        emp = employees.get(cid)
        if emp is None:
            u = users.get(cid)
            emp = _blank_emp(cid, (u.full_name or u.email) if u else cid)
            employees[cid] = emp

        hours = _native_entry_hours(e)
        emp["computed_hours"] += hours
        # Miles count for every punch, classified or not — driving is driving,
        # same as the Connecteam path where mileage is independent of pay bucket.
        emp["miles"] += e.miles or 0.0

        u = users.get(cid)
        res_rate = u.pay_rate_residential if (u and u.pay_rate_residential is not None) else rates["residential_rate"]
        rental_rate = u.pay_rate_rental if (u and u.pay_rate_rental is not None) else rates["rental_weekday_rate"]
        deep_rate = u.pay_rate_deep if (u and u.pay_rate_deep is not None) else rates["deep_clean_rate"]

        job = e.job
        prop = job.property if job is not None else None
        d = _native_local_date(e.clock_in_at)
        weekend = _is_weekend(d)
        # Classification by job_type: str_turnover → rental, deep_clean → deep,
        # else residential.
        if job is None:
            kind = None
        elif job.job_type == "str_turnover":
            kind = "rental"
        elif job.job_type == "deep_clean":
            kind = "deep"
        else:
            kind = "residential"

        # Effective pay mode: a per-job override (job.pay_mode) beats the
        # automatic rule (weekend rental → piece; everything else hourly). Lets
        # the office pay a specific weekend airbnb hourly, or force a piece rate.
        job_pay_mode = (getattr(job, "pay_mode", None) or "auto").lower() if job is not None else "auto"
        if job_pay_mode == "piece":
            use_piece = True
        elif job_pay_mode == "hourly":
            use_piece = False
        else:  # auto
            use_piece = (kind == "rental" and weekend)

        detail = {
            "shift_id": f"native:{e.id}",
            "date": d.isoformat(),
            "weekend": weekend,
            "hours": round(hours, 2),
            "miles": round(e.miles or 0.0, 1),
            "kind": kind or "unclassified",
            "source": "native_job" if job is not None else "unlinked",
            "property": prop.name if prop is not None else None,
            "shift_title": "",
            "job_label": (job.title if job is not None else "") or "",
            "rate_pay": use_piece,
            "note": e.note or "",
            "pay": 0.0,
        }

        if kind is None:
            emp["unclassified_hours"] += hours
            unclassified_shifts += 1
            emp["shifts"].append(detail)
            continue

        if use_piece:
            # Piece rate per distinct (property, date) — the turnover model.
            # Reached for a weekend rental (auto) or any job the office set to
            # "piece". Non-weekend piece is allowed but rare.
            emp["weekend_rental_hours"] += hours
            key = prop.id if prop is not None else f"job:{job.id if job else 'x'}"
            seen = emp["_weekend_seen"].setdefault(key, set())
            first_today = d.isoformat() not in seen
            seen.add(d.isoformat())
            if first_today:
                emp["weekend_turnovers"] += 1
                rate = getattr(prop, "turnover_rate", None) if prop is not None else None
                if rate is None:
                    emp["weekend_unpriced_turnovers"] += 1
                    warnings.append(
                        f"{emp['name']}: turnover at {detail['property'] or 'unknown property'} "
                        f"on {d.isoformat()} has no piece rate set — not included in pay."
                    )
                else:
                    emp["weekend_pay"] += float(rate)
                    detail["pay"] = round(float(rate), 2)
        elif kind == "deep":
            # Deep cleans are hourly at the deep rate, weekday OR weekend.
            emp["deep_clean_hours"] += hours
            pay = hours * deep_rate
            emp["deep_clean_pay"] += pay
            detail["pay"] = round(pay, 2)
        elif kind == "rental":
            # Hourly rental: a weekday turnover (auto) or a weekend one the office
            # set to hourly instead of piece.
            emp["rental_weekday_hours"] += hours
            pay = hours * rental_rate
            emp["rental_weekday_pay"] += pay
            detail["pay"] = round(pay, 2)
        else:  # residential
            emp["residential_hours"] += hours
            pay = hours * res_rate
            emp["residential_pay"] += pay
            detail["pay"] = round(pay, 2)
        emp["shifts"].append(detail)

    out_emps = []
    for emp in employees.values():
        emp["computed_hours"] = round(emp["computed_hours"], 2)
        # The native clock IS the source of truth — no external "official" total.
        emp["total_hours"] = emp["computed_hours"]
        emp["hours_source"] = "native"
        emp["connecteam_hours"] = None
        accounted = (emp["residential_hours"] + emp["deep_clean_hours"]
                     + emp["rental_weekday_hours"]
                     + emp["weekend_rental_hours"] + emp["unclassified_hours"])
        emp["unallocated_hours"] = round(emp["total_hours"] - accounted, 2)
        # Native mileage: crew-entered miles per punch × the Settings mileage
        # rate (IRS default), reimbursed on top of piece/hourly pay — same
        # formula the Connecteam path uses.
        emp["mileage_reimbursement"] = round(emp["miles"] * rates["mileage_rate"], 2)
        emp["gross_pay"] = round(
            emp["residential_pay"] + emp["deep_clean_pay"] + emp["rental_weekday_pay"]
            + emp["weekend_pay"] + emp["mileage_reimbursement"], 2
        )
        for k in ("total_hours", "residential_hours", "residential_pay",
                  "deep_clean_hours", "deep_clean_pay",
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
        "deep_clean_hours": round(sum(e["deep_clean_hours"] for e in out_emps), 2),
        "deep_clean_pay": round(sum(e["deep_clean_pay"] for e in out_emps), 2),
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
            f"{unclassified_shifts} punch(es) weren't clocked into a specific job, so their "
            f"hours couldn't be split into residential vs rental. They're listed as "
            f"'unclassified' and left out of pay."
        ))
    if totals["miles"] == 0:
        warnings.append(
            "Reading hours and mileage from the native BrightBase clock. No miles "
            "were entered for this period — if crew drove, have them enter miles at "
            "clock-out (or correct a punch)."
        )
    else:
        warnings.append("Reading hours and mileage from the native BrightBase clock.")

    return {
        "period": f"{start_date} to {end_date}",
        "start_date": start_date,
        "end_date": end_date,
        "rates": rates,
        "hours_source": "native",
        "source": "native",
        "employees": out_emps,
        "totals": totals,
        "warnings": warnings,
    }


@router.get("/summary", dependencies=[Depends(require_role("admin", "manager"))])
async def payroll_summary(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
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

    # Flag-gated cutover: read hours from the native BrightBase clock instead of
    # Connecteam when payroll_source='native' (off by default). Same response
    # shape, so the Payroll page is agnostic to the source.
    if _payroll_source(db) == "native":
        return _native_summary(db, start_date, end_date, rates, resolve_org_id(org_id, db))

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
    # Scheduled-shift index: { schedulerShiftId → {title, tags} }. The shift
    # TITLE ("Wells Rental Turnover" vs "Residential") is the most reliable
    # residential/rental signal — the Connecteam job is just the client name.
    # Tags let us auto-flag piece-rate ("Rate Pay") shifts.
    sched_index: dict = {}
    try:
        for s in await get_scheduled_shifts(start_date, end_date):
            if s.get("id"):
                sched_index[str(s["id"])] = {"title": s.get("title") or "", "tags": s.get("tags") or []}
    except Exception:
        sched_index = {}
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

        # ── Classify: CRM job (authoritative) → scheduled-shift title → the
        # Connecteam job (client) name → unknown. The scheduled-shift title is
        # the real "what kind of clean" signal ("Wells Rental Turnover").
        kind = None
        prop = None
        source = "unlinked"
        sched = sched_index.get(r["schedulerShiftId"]) if r["schedulerShiftId"] else None
        shift_title = (sched or {}).get("title") or ""
        shift_tags = (sched or {}).get("tags") or []
        rate_pay = any("rate pay" in str(t).lower() or "piece" in str(t).lower() for t in shift_tags)
        crm_job = crm_index.get(r["schedulerShiftId"]) if r["schedulerShiftId"] else None
        if crm_job is not None:
            kind = "rental" if crm_job.job_type == "str_turnover" else "residential"
            prop = crm_job.property
            source = "crm"
        elif shift_title:
            kind = _classify_name(shift_title)
            source = "shift_title"
        elif r["jobId"] and str(r["jobId"]) in ct_jobs:
            kind = _classify_name(ct_jobs[str(r["jobId"])]["name"])
            source = "job_name"
        elif r["jobId"]:
            kind = _classify_name(str(r["jobId"]))
            source = "job_name"

        # A job clock-in name for display: prefer the scheduled-shift title,
        # else the Connecteam job (client) name.
        job_label = shift_title or (ct_jobs.get(str(r["jobId"])) or {}).get("name") if r.get("jobId") else shift_title

        detail = {
            "shift_id": r["shiftId"],
            "date": d.isoformat(),
            "weekend": weekend,
            "hours": round(hours, 2),
            "miles": r["miles"],
            "kind": kind or "unclassified",
            "source": source,
            "property": prop.name if prop is not None else None,
            "shift_title": shift_title,
            "job_label": job_label or "",
            "rate_pay": rate_pay,
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
        "deep_clean_hours": round(sum(e["deep_clean_hours"] for e in out_emps), 2),
        "deep_clean_pay": round(sum(e["deep_clean_pay"] for e in out_emps), 2),
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
        "source": "connecteam",
        "employees": out_emps,
        "totals": totals,
        "warnings": warnings,
    }


def _norm_name(s: str) -> str:
    return " ".join((s or "").lower().split())


def _classify_row(r: dict, sched_index: dict, crm_index: dict, ct_jobs: dict):
    """Same residential/rental classification the /summary endpoint uses, as a
    helper so the Square export stays consistent: CRM job → scheduled-shift
    title → Connecteam job name. Returns (kind, property, shift_title)."""
    sched = sched_index.get(r["schedulerShiftId"]) if r["schedulerShiftId"] else None
    shift_title = (sched or {}).get("title") or ""
    crm_job = crm_index.get(r["schedulerShiftId"]) if r["schedulerShiftId"] else None
    if crm_job is not None:
        return ("rental" if crm_job.job_type == "str_turnover" else "residential"), crm_job.property, shift_title
    if shift_title:
        return _classify_name(shift_title), None, shift_title
    if r["jobId"] and str(r["jobId"]) in ct_jobs:
        return _classify_name(ct_jobs[str(r["jobId"])]["name"]), None, shift_title
    if r["jobId"]:
        return _classify_name(str(r["jobId"])), None, shift_title
    return None, None, shift_title


class SendToSquareBody(BaseModel):
    start_date: str
    end_date: str
    dry_run: bool = True
    # Manual per-shift overrides from the Payroll page: { shift_id: {mode, amount} }.
    overrides: dict = {}


@router.post("/send-to-square", dependencies=[Depends(require_role("admin"))])
async def send_to_square(body: SendToSquareBody, db: Session = Depends(get_db)):
    """Push the period's HOURLY hours to Square as Labor API Timecards (which
    Square Payroll then imports), and return the piece-rate + mileage amounts as
    a per-person adjustment list to enter in Square manually.

    Defaults to a DRY RUN — it matches people and shows exactly what WOULD be
    sent (nothing is written to Square) so the operator can verify before
    committing. Set dry_run=false to actually create the timecards."""
    # The Square export still sources hours from Connecteam; block it while the
    # payroll source is native so a preview/submission can't silently diverge
    # from (or outlive) the native hours the admin just reviewed.
    if _payroll_source(db) == "native":
        raise HTTPException(
            status_code=400,
            detail="Square export from the native clock isn't wired up yet. Switch Payroll's "
                   "hours source back to Connecteam, or use Export CSV.",
        )
    from integrations import square
    if not square.is_configured():
        raise HTTPException(status_code=400, detail="Square isn't connected — add a token + location in Settings.")
    try:
        d0 = datetime.strptime(body.start_date, "%Y-%m-%d").date()
        d1 = datetime.strptime(body.end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD")
    if d1 < d0:
        raise HTTPException(status_code=422, detail="End date is before start date")

    rates = _get_rates(db)
    res_cents = square.dollars_to_cents(rates["residential_rate"])
    rental_cents = square.dollars_to_cents(rates["rental_weekday_rate"])

    try:
        rows = await get_time_activities(body.start_date, body.end_date)
    except ConnecteamAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Connecteam error: {e}")

    # Classification context (best-effort).
    sched_index: dict = {}
    try:
        for s in await get_scheduled_shifts(body.start_date, body.end_date):
            if s.get("id"):
                sched_index[str(s["id"])] = {"title": s.get("title") or ""}
    except Exception:
        sched_index = {}
    try:
        ct_jobs = await get_jobs()
    except Exception:
        ct_jobs = {}
    crm_index = _crm_shift_index(db, body.start_date, body.end_date)

    # Match Connecteam people → Square team members (email first, then name).
    try:
        ct_team = {m["id"]: m for m in await get_team()}
    except Exception:
        ct_team = {}
    try:
        names = _employee_name_map(await get_employees())
    except Exception:
        names = {}
    try:
        sq_members = await square.list_team_members()
    except square.SquareAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Square error: {e}")
    sq_by_email = {m["email"]: m for m in sq_members if m["email"]}
    sq_by_name = {_norm_name(m["name"]): m for m in sq_members}

    def match_square(uid: str):
        person = ct_team.get(uid) or {}
        email = (person.get("email") or "").strip().lower()
        if email and email in sq_by_email:
            return sq_by_email[email]
        nm = _norm_name(person.get("name") or names.get(uid, ""))
        return sq_by_name.get(nm)

    # Square wage "jobs" the operator runs payroll from (Residential / Rental /
    # Rate Pay), so timecards carry the right title and Square's own configured
    # rate for that job (falling back to the BrightBase rate when absent).
    jobs = {
        "residential": get_setting(db, "square_job_residential") or "Residential",
        "rental": get_setting(db, "square_job_rental") or "Rental",
    }
    try:
        sq_wages = (await square.list_team_member_wages())["by_member"]
    except Exception:
        sq_wages = {}

    # Build per-employee timecards + adjustments.
    emps: dict = {}
    for r in rows:
        uid = str(r["userId"])
        e = emps.get(uid)
        if e is None:
            sqm = match_square(uid)
            e = {"employee_id": uid, "name": ct_team.get(uid, {}).get("name") or names.get(uid, uid),
                 "timecards": [], "piece_total": 0.0, "piece_count": 0, "miles": 0.0,
                 "unpriced": 0, "excluded": 0,
                 "_square": sqm,
                 "square_team_member_id": sqm["id"] if sqm else None,
                 "square_name": sqm["name"] if sqm else None,
                 "matched": bool(sqm)}
            emps[uid] = e
        e["miles"] += r["miles"]
        kind, prop, title = _classify_row(r, sched_index, crm_index, ct_jobs)
        d = _local_date(r["startTimestamp"], r["timezone"])
        weekend = _is_weekend(d)
        ov = body.overrides.get(r["shiftId"]) or {}
        mode = ov.get("mode") or "auto"
        label = title or (ct_jobs.get(str(r["jobId"])) or {}).get("name") or (kind or "Cleaning")

        if mode == "exclude":
            e["excluded"] += 1
            continue
        if mode == "piece" or (mode == "auto" and kind == "rental" and weekend):
            if mode == "piece":
                amt = float(ov.get("amount") or 0)
            else:
                amt = float(getattr(prop, "turnover_rate", None) or 0)
            if amt > 0:
                e["piece_total"] += amt
                e["piece_count"] += 1
            else:
                e["unpriced"] += 1
            continue
        if kind is None:
            e["excluded"] += 1  # unclassified — leave out of Square, flag via excluded
            continue
        # Hourly (residential, rental weekday, or override→hourly). Tag the
        # timecard with the Square job title so hours land in the right bucket,
        # and prefer Square's configured rate for that (person, job).
        job_title = jobs["rental"] if kind == "rental" else jobs["residential"]
        rate_cents = rental_cents if kind == "rental" else res_cents
        rate_source = "brightbase"
        if e["_square"]:
            cfg = sq_wages.get((e["_square"]["id"], job_title.lower()))
            if cfg:
                rate_cents = int(cfg)
                rate_source = "square"
        # End = start + net hours so Square's computed hours == our net.
        end_ts = int(r["startTimestamp"] + round(r["netHours"] * 3600))
        e["timecards"].append({
            "shift_id": r["shiftId"],
            "title": job_title,
            "start_ts": r["startTimestamp"],
            "end_ts": end_ts,
            "hours": round(r["netHours"], 2),
            "rate": rate_cents / 100.0,
            "rate_cents": rate_cents,
            "rate_source": rate_source,
            "kind": kind,
        })

    location = square._get_location()
    out_emps = []
    total_timecards = 0
    for e in emps.values():
        e.pop("_square", None)
        e["mileage_reimbursement"] = round(e["miles"] * rates["mileage_rate"], 2)
        e["piece_total"] = round(e["piece_total"], 2)
        e["timecard_count"] = len(e["timecards"])
        total_timecards += len(e["timecards"])
        out_emps.append(e)
    out_emps.sort(key=lambda x: str(x["name"]).lower())

    any_square_rate = any(tc.get("rate_source") == "square"
                          for e in out_emps for tc in e["timecards"])
    result = {
        "dry_run": body.dry_run,
        "period": f"{body.start_date} to {body.end_date}",
        "location_id": location,
        "jobs": jobs,
        "square_rates_used": any_square_rate,
        "matched": sum(1 for e in out_emps if e["matched"]),
        "unmatched": [e["name"] for e in out_emps if not e["matched"]],
        "timecards_total": total_timecards,
        "employees": out_emps,
    }

    if body.dry_run:
        return result

    # Real send — only for matched people; idempotency key makes re-runs safe.
    created, errors = 0, []
    for e in out_emps:
        if not e["matched"]:
            continue
        for tc in e["timecards"]:
            try:
                res = await square.create_timecard(
                    team_member_id=e["square_team_member_id"],
                    start_ts=tc["start_ts"], end_ts=tc["end_ts"],
                    hourly_rate_cents=tc["rate_cents"], title=tc["title"],
                    idempotency_key=f"bb-{tc['shift_id']}-{e['square_team_member_id']}",
                    location_id=location,
                )
                if res.get("ok"):
                    created += 1
                else:
                    errors.append({"employee": e["name"], "shift": tc["shift_id"], "error": res.get("error")})
            except square.SquareAuthError as ex:
                raise HTTPException(status_code=503, detail=str(ex))
            except Exception as ex:
                errors.append({"employee": e["name"], "shift": tc["shift_id"], "error": str(ex)})
    result["created"] = created
    result["errors"] = errors
    return result


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
