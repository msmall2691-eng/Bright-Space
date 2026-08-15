"""Payroll — turn native time-clock punches into a payroll-ready breakdown.

The page this feeds answers one question for a pay period: for each crew member,
how many hours on residential cleans vs rental turnovers vs deep cleans, how
many weekend turnovers, and what do we owe them? Pay rules (operator-editable
in Settings / on the page):

  * Residential hours (any day) ........ $/hr  (pay_rate_residential, default 25)
  * Deep-clean hours (any day) ......... $/hr  (pay_rate_deep_clean; defaults to
                                         the residential rate until set higher)
  * Rental hours on a WEEKDAY .......... $/hr  (pay_rate_rental_weekday, default 26)
  * Rental turnover on a WEEKEND ....... piece rate per turnover, set per-property
                                         (Property.turnover_rate)
  * Per-job hourly bump ................ Job.pay_rate_bump adds $/hr on top of
                                         the applicable hourly rate (piece ignores it)
  * Mileage ............................ miles * mileage_rate (default IRS 0.67)

Hours come from the native crew clock (time_entries): classification is the
punch's linked job (job_type + pay_mode + weekend), per-cleaner rate overrides
(User.pay_rate_*) apply over the shop defaults, and punches with no job are
surfaced as 'unclassified' and never silently paid. The Connecteam source was
removed outright (Connecteam-removal step 5) — this module reads only our DB.
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


def _is_weekend(d: date) -> bool:
    return d.weekday() >= 5  # Sat=5, Sun=6


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


def _blank_emp(uid, name) -> dict:
    return {
        "employee_id": uid,
        "name": name,
        "total_hours": 0.0,
        "computed_hours": 0.0,       # punch-summed total
        "connecteam_hours": None,    # legacy response key (always None) — kept so
                                     # the Payroll page shape never shifted
        "hours_source": "native",
        "unallocated_hours": 0.0,    # total minus classified buckets
        "residential_hours": 0.0,
        "residential_pay": 0.0,
        "deep_clean_hours": 0.0,
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
    decides weekday vs weekend."""
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
        # Per-job hourly bump (the "+$1/hr for a two-cleaner deep clean /
        # weekday immediate turnover" offer): added to whichever hourly rate
        # applies. Piece pay ignores it — the flat turnover rate is the whole
        # payment for that job.
        bump = float(getattr(job, "pay_rate_bump", None) or 0.0) if job is not None else 0.0
        res_rate += bump
        rental_rate += bump
        deep_rate += bump
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
            # Ids alongside the display strings so the payroll UI can link a
            # shift row to its job/property record instead of dead-ending at a
            # label (an unlinked punch has neither).
            "job_id": job.id if job is not None else None,
            "property_id": prop.id if prop is not None else None,
            "property": prop.name if prop is not None else None,
            "shift_title": "",
            "job_label": (job.title if job is not None else "") or "",
            "rate_pay": use_piece,
            "rate_bump": bump or 0.0,
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
def payroll_summary(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """The payroll-ready breakdown for a pay period: per-crew hours split into
    residential / deep / rental-weekday / weekend-turnover buckets, mileage, and
    a computed gross — from the native time clock. This is the endpoint the
    Payroll page runs on."""
    try:
        d0 = datetime.strptime(start_date, "%Y-%m-%d").date()
        d1 = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD")
    if d1 < d0:
        raise HTTPException(status_code=422, detail="End date is before start date")
    if (d1 - d0).days > 92:
        raise HTTPException(status_code=422, detail="Pay periods are capped at 92 days")

    rates = _get_rates(db)
    return _native_summary(db, start_date, end_date, rates, resolve_org_id(org_id, db))


def _norm_name(s: str) -> str:
    return " ".join((s or "").lower().split())


class SendToSquareBody(BaseModel):
    start_date: str
    end_date: str
    dry_run: bool = True
    # Manual per-shift overrides from the Payroll page: { shift_id: {mode, amount} }.
    overrides: dict = {}


async def _native_send_to_square(body: SendToSquareBody, db: Session, oid: int) -> dict:
    """Square export sourced from the NATIVE time clock: hourly punches become
    Labor API Timecards at each cleaner's effective BrightBase rate (per-cleaner
    override or shop default, plus the job's hourly bump); piece-rate work and
    mileage come back as a per-person adjustment list to enter in Square
    manually. Same response shape as the Connecteam path so the Payroll page's
    preview panel renders it unchanged.

    Two deliberate differences from the Connecteam path:
    * People match by the native User's EMAIL first (every native cleaner has
      one — it's their login), then name. No Connecteam directory involved.
    * Timecards always carry the BrightBase rate (rate_source='brightbase').
      BrightBase is the source of truth for pay intent — per-cleaner overrides
      and per-job bumps live here, and silently preferring a Square-configured
      wage would drop the bump the office just set.
    """
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

    # Same punch window as _native_summary: business-local [d0, d1] inclusive.
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
        .order_by(TimeEntry.clock_in_at)
        .all()
    )

    users: dict = {}
    cleaner_ids = {e.cleaner_id for e in entries}
    if cleaner_ids:
        for u in db.query(User).filter(
            User.cleaner_id.in_(cleaner_ids),
            or_(User.org_id == oid, User.org_id.is_(None)),
        ).all():
            users[u.cleaner_id] = u

    try:
        sq_members = await square.list_team_members()
    except square.SquareAuthError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Square error: {e}")
    sq_by_email = {(m["email"] or "").strip().lower(): m for m in sq_members if m.get("email")}
    sq_by_name = {_norm_name(m["name"]): m for m in sq_members}

    def match_square(u, fallback_name: str):
        email = ((u.email if u else "") or "").strip().lower()
        if email and email in sq_by_email:
            return sq_by_email[email]
        return sq_by_name.get(_norm_name((u.full_name if u else "") or fallback_name))

    # Square wage-job titles per pay bucket, so hours land under the right job
    # in Square Payroll. Deep cleans get their own title (native classifies
    # them; the Connecteam path never could).
    jobs = {
        "residential": get_setting(db, "square_job_residential") or "Residential",
        "rental": get_setting(db, "square_job_rental") or "Rental",
        "deep": get_setting(db, "square_job_deep") or "Deep Clean",
    }

    emps: dict = {}
    piece_seen: dict = {}  # (cleaner_id, prop-or-job key) → set of local dates
    for e in entries:
        cid = e.cleaner_id
        emp = emps.get(cid)
        u = users.get(cid)
        if emp is None:
            sqm = match_square(u, cid)
            emp = {"employee_id": cid,
                   "name": (u.full_name or u.email) if u else cid,
                   "timecards": [], "piece_total": 0.0, "piece_count": 0, "miles": 0.0,
                   "unpriced": 0, "excluded": 0,
                   "square_team_member_id": sqm["id"] if sqm else None,
                   "square_name": sqm["name"] if sqm else None,
                   "matched": bool(sqm)}
            emps[cid] = emp
        emp["miles"] += e.miles or 0.0

        hours = _native_entry_hours(e)
        job = e.job
        prop = job.property if job is not None else None
        d = _native_local_date(e.clock_in_at)
        weekend = _is_weekend(d)
        if job is None:
            kind = None
        elif job.job_type == "str_turnover":
            kind = "rental"
        elif job.job_type == "deep_clean":
            kind = "deep"
        else:
            kind = "residential"

        # Same effective-mode resolution as /summary, then the page's manual
        # per-shift override on top (keyed by the summary's 'native:{id}').
        job_pay_mode = (getattr(job, "pay_mode", None) or "auto").lower() if job is not None else "auto"
        auto_piece = (kind == "rental" and weekend) if job_pay_mode == "auto" else (job_pay_mode == "piece")
        ov = body.overrides.get(f"native:{e.id}") or {}
        mode = ov.get("mode") or "auto"

        if mode == "exclude":
            emp["excluded"] += 1
            continue
        if mode == "piece" or (mode == "auto" and auto_piece):
            if mode == "piece" and ov.get("amount"):
                amt = float(ov.get("amount") or 0)
            else:
                amt = float(getattr(prop, "turnover_rate", None) or 0)
            # One piece payment per distinct (property, local date) — a second
            # punch at the same turnover the same day is part of the same job.
            key = (cid, prop.id if prop is not None else f"job:{job.id if job else 'x'}")
            seen = piece_seen.setdefault(key, set())
            if d.isoformat() in seen:
                continue
            seen.add(d.isoformat())
            if amt > 0:
                emp["piece_total"] += amt
                emp["piece_count"] += 1
            else:
                emp["unpriced"] += 1
            continue
        if kind is None:
            emp["excluded"] += 1  # unlinked punch — never silently paid
            continue

        # Hourly: the cleaner's effective BrightBase rate + the job's bump.
        bump = float(getattr(job, "pay_rate_bump", None) or 0.0)
        if kind == "deep":
            rate = (u.pay_rate_deep if (u and u.pay_rate_deep is not None) else rates["deep_clean_rate"]) + bump
        elif kind == "rental":
            rate = (u.pay_rate_rental if (u and u.pay_rate_rental is not None) else rates["rental_weekday_rate"]) + bump
        else:
            rate = (u.pay_rate_residential if (u and u.pay_rate_residential is not None) else rates["residential_rate"]) + bump
        rate_cents = square.dollars_to_cents(rate)
        start_ts = int(e.clock_in_at.replace(tzinfo=_tz.utc).timestamp())
        end_ts = int(start_ts + round(hours * 3600))
        emp["timecards"].append({
            "shift_id": f"native:{e.id}",
            "title": jobs[kind],
            "start_ts": start_ts,
            "end_ts": end_ts,
            "hours": round(hours, 2),
            "rate": rate_cents / 100.0,
            "rate_cents": rate_cents,
            "rate_source": "brightbase",
            "kind": kind,
        })

    location = square._get_location()
    out_emps = []
    total_timecards = 0
    for emp in emps.values():
        emp["mileage_reimbursement"] = round(emp["miles"] * rates["mileage_rate"], 2)
        emp["miles"] = round(emp["miles"], 1)
        emp["piece_total"] = round(emp["piece_total"], 2)
        emp["timecard_count"] = len(emp["timecards"])
        total_timecards += len(emp["timecards"])
        out_emps.append(emp)
    out_emps.sort(key=lambda x: str(x["name"]).lower())

    result = {
        "dry_run": body.dry_run,
        "period": f"{body.start_date} to {body.end_date}",
        "location_id": location,
        "jobs": jobs,
        "square_rates_used": False,
        "source": "native",
        "matched": sum(1 for e in out_emps if e["matched"]),
        "unmatched": [e["name"] for e in out_emps if not e["matched"]],
        "timecards_total": total_timecards,
        "employees": out_emps,
    }
    if body.dry_run:
        return result

    created, errors = 0, []
    for emp in out_emps:
        if not emp["matched"]:
            continue
        for tc in emp["timecards"]:
            try:
                res = await square.create_timecard(
                    team_member_id=emp["square_team_member_id"],
                    start_ts=tc["start_ts"], end_ts=tc["end_ts"],
                    hourly_rate_cents=tc["rate_cents"], title=tc["title"],
                    # Stable per native punch (R4): re-running the export can't
                    # duplicate a timecard.
                    idempotency_key=f"bb-{tc['shift_id']}-{emp['square_team_member_id']}",
                    location_id=location,
                )
                if res.get("ok"):
                    created += 1
                else:
                    errors.append({"employee": emp["name"], "shift": tc["shift_id"], "error": res.get("error")})
            except square.SquareAuthError as ex:
                raise HTTPException(status_code=503, detail=str(ex))
            except Exception as ex:
                errors.append({"employee": emp["name"], "shift": tc["shift_id"], "error": str(ex)})
    result["created"] = created
    result["errors"] = errors
    return result


@router.post("/send-to-square", dependencies=[Depends(require_role("admin"))])
async def send_to_square(body: SendToSquareBody, db: Session = Depends(get_db),
                         org_id: int = Depends(current_org_id)):
    """Push the period's HOURLY hours to Square as Labor API Timecards (which
    Square Payroll then imports), and return the piece-rate + mileage amounts as
    a per-person adjustment list to enter in Square manually.

    Defaults to a DRY RUN — it matches people and shows exactly what WOULD be
    sent (nothing is written to Square) so the operator can verify before
    committing. Set dry_run=false to actually create the timecards. Hours come
    from the native BrightBase clock."""
    return await _native_send_to_square(body, db, resolve_org_id(org_id, db))


