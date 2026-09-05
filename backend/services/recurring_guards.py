"""Pre-create similarity guard for recurring series.

Data-model review follow-up (guard 1): ``POST /api/recurring`` did no
pre-existence check, so a double-create (or a re-create after a split left the
retired predecessor looking alive) silently produced two live series feeding
the same calendar slot — the "two Sandra Fox, every 4 weeks on Fri" case the
frontend duplicate flag keeps catching after the fact. This service catches it
BEFORE the row exists; the router turns matches into an overridable 409
(``allow_duplicate: true`` resubmit), mirroring scheduling's
``allow_conflicts`` escape hatch.

Lives here rather than in the router per scheduling-invariants R6 (routers
route; business logic goes in a service). Read-only: this module never writes
anything.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database.models import Client, Job, Property, RecurringSchedule
from utils.dates import business_today, coerce_date, coerce_time

_DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _effective_days(days_of_week, day_of_week, frequency: Optional[str] = None) -> Set[int]:
    """Day-of-week set for comparison (mirrors the router's _effective_days:
    legacy single-day fallback, clamped to 0-6). For a DAILY rule an empty
    set means "every day", so it compares as all seven days."""
    if days_of_week:
        cleaned = {
            int(d) for d in days_of_week
            if isinstance(d, (int, float)) and 0 <= int(d) <= 6
        }
        if cleaned:
            return cleaned
    if frequency == "daily":
        return set(range(7))
    return {day_of_week} if day_of_week is not None else {0}


def _cadence_text(sched: RecurringSchedule) -> str:
    """Compact human summary, e.g. 'Biweekly Tue 9:00' — what the confirm
    prompt shows next to the existing series."""
    interval = sched.interval_weeks or 1
    if sched.frequency == "monthly":
        base = f"Monthly on day {sched.day_of_month or 1}"
    elif sched.frequency == "daily":
        base = "Daily" if interval <= 1 else f"Every {interval} days"
    else:
        cadence = ("Weekly" if interval == 1 else
                   "Biweekly" if interval == 2 else f"Every {interval} weeks")
        days = sorted(_effective_days(sched.days_of_week, sched.day_of_week, sched.frequency))
        base = f"{cadence} {'/'.join(_DAY_ABBR[d] for d in days)}"
    st = coerce_time(sched.start_time)
    if st is not None:
        base += f" {st.hour}:{st.minute:02d}"
    return base


def find_similar_series(db: Session, org_id: Optional[int], payload: Dict[str, Any]) -> List[dict]:
    """Live series that look like the one about to be created.

    A match is a series that is active AND not ended (series_end_date IS NULL
    OR > today — a split-retired predecessor with only its end date set must
    NOT trip the guard) with the same client, same property (both-None counts
    as same), same frequency + interval + day_of_month + start_time, and an
    OVERLAPPING day-of-week set: a new Wednesday series matches an existing
    Mon/Wed/Fri one, because both would put a crew there on Wednesdays.

    Returns compact JSON-safe dicts for the 409 payload; empty list = clear
    to create.
    """
    today = business_today()
    frequency = payload.get("frequency")
    new_days = _effective_days(payload.get("days_of_week"), payload.get("day_of_week"), frequency)
    new_start = coerce_time(payload.get("start_time"))
    new_interval = payload.get("interval_weeks") or 1
    new_dom = payload.get("day_of_month")
    # COALESCE(property_id, -1) semantics: a series with no property only
    # matches another with no property.
    new_prop = payload.get("property_id") if payload.get("property_id") is not None else -1

    candidates = db.query(RecurringSchedule).filter(
        RecurringSchedule.client_id == payload.get("client_id"),
        RecurringSchedule.frequency == frequency,
        RecurringSchedule.active == True,  # noqa: E712
        or_(RecurringSchedule.org_id == org_id, RecurringSchedule.org_id.is_(None)),
    ).all()

    matches: List[RecurringSchedule] = []
    for s in candidates:
        end = coerce_date(s.series_end_date)
        if end is not None and end <= today:
            continue  # ended — retired, not a live duplicate
        if (s.property_id if s.property_id is not None else -1) != new_prop:
            continue
        if (s.interval_weeks or 1) != new_interval:
            continue
        if (s.day_of_month or None) != (new_dom or None):
            continue
        if coerce_time(s.start_time) != new_start:
            continue
        if frequency != "monthly":
            if not (_effective_days(s.days_of_week, s.day_of_week, s.frequency) & new_days):
                continue
        matches.append(s)

    if not matches:
        return []

    # Upcoming-visit counts + property names for the matches: two small
    # grouped/IN queries (same shape get_schedules uses), cheap at this size.
    ids = [s.id for s in matches]
    count_rows = (
        db.query(Job.recurring_schedule_id, func.count(Job.id))
        .filter(
            Job.recurring_schedule_id.in_(ids),
            Job.status != "cancelled",
            or_(Job.scheduled_date == None, Job.scheduled_date >= today.isoformat()),  # noqa: E711
        )
        .group_by(Job.recurring_schedule_id)
        .all()
    )
    counts = {sid: c for sid, c in count_rows}
    prop_ids = [s.property_id for s in matches if s.property_id]
    prop_names = {}
    if prop_ids:
        prop_names = dict(
            db.query(Property.id, Property.name).filter(Property.id.in_(prop_ids)).all()
        )

    out = []
    for s in matches:
        st = coerce_time(s.start_time)
        out.append({
            "id": s.id,
            "title": s.title,
            "address": s.address,
            "property_id": s.property_id,
            "property_name": prop_names.get(s.property_id),
            "cadence": _cadence_text(s),
            "start_time": f"{st.hour:02d}:{st.minute:02d}" if st is not None else None,
            "upcoming_job_count": counts.get(s.id, 0),
        })
    return out


# ── Recurring Doctor: whole-org series audit ────────────────────────────────
#
# Owner report (Aug 2026 screenshot): the live Recurring list carried a series
# titled just "biweekly" with no time set and 0 upcoming, the same client's
# real series paused next to it, a twice-created "Every 3 weeks" pair, and an
# ended series still listed. The creation guard above stops NEW duplicates;
# this audit finds the EXISTING sick rows and says what's wrong with each, so
# the UI can offer reviewed fixes. Read-only, like everything in this module —
# fixes go through the normal PATCH/DELETE endpoints with a human confirm
# (data-cleanup rule: propose, never silently mutate).

_JUNK_TITLES = {
    "weekly", "biweekly", "bi-weekly", "monthly", "daily", "recurring",
    "clean", "cleaning", "residential", "commercial", "new", "test", "series",
}


def _is_live(s: RecurringSchedule, today) -> bool:
    if not s.active:
        return False
    end = coerce_date(s.series_end_date)
    return end is None or end > today


def _dup_bucket_key(s: RecurringSchedule):
    st = coerce_time(s.start_time)
    return (
        s.client_id,
        s.property_id if s.property_id is not None else -1,
        s.frequency,
        s.interval_weeks or 1,
        s.day_of_month or None,
        (st.hour, st.minute) if st is not None else None,
    )


def _group_live_duplicates(rows: List[RecurringSchedule], today) -> List[List[int]]:
    """Groups of live series that would trip the creation guard against each
    other: same bucket (client/property/cadence/time) + overlapping day sets,
    chained transitively (Mon/Wed + Wed/Fri + Fri = one group)."""
    buckets: Dict[Any, List[RecurringSchedule]] = {}
    for s in rows:
        if _is_live(s, today):
            buckets.setdefault(_dup_bucket_key(s), []).append(s)

    groups: List[List[int]] = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        # Union-find on day-set overlap within the bucket.
        parent = {s.id: s.id for s in members}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        day_sets = {s.id: _effective_days(s.days_of_week, s.day_of_week, s.frequency)
                    for s in members}
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if a.frequency == "monthly" or (day_sets[a.id] & day_sets[b.id]):
                    ra, rb = find(a.id), find(b.id)
                    if ra != rb:
                        parent[ra] = rb
        clusters: Dict[int, List[int]] = {}
        for s in members:
            clusters.setdefault(find(s.id), []).append(s.id)
        groups.extend(sorted(c) for c in clusters.values() if len(c) > 1)
    return groups


def _group_paused_duplicates(rows: List[RecurringSchedule], today) -> List[List[int]]:
    """Groups of PAUSED copies of the same series.

    `_group_live_duplicates` only looks at live rows, which is right for the
    "you'd trip the creation guard" finding. But the owner's list is mostly
    paused: the same house appears three and four times because a duplicate was
    paused rather than cancelled, and pausing takes a row out of `_is_live` —
    so the duplicate detector could not see a single one of them. Thirty-two
    series, most of them the same dozen houses, and no finding said so.

    MIXED GROUPS ARE THE COMMON CASE, and the first version of this missed
    them. After an "all future visits" edit the old series is left behind and a
    new one takes over, so the usual shape is ONE LIVE copy and one or more
    paused ones — which fell through both detectors, because the live one
    needs every member live and this one needed every member paused. Owner
    screenshot: Sandra Fox with two identical "Every 4 weeks Fri 9:00" series
    and Paul Day with two "Biweekly Mon 9:00", one of each still running.

    So live rows are bucketed too — they're what a paused copy is a duplicate
    OF — but only the PAUSED ones are returned. A live series is never
    something to cancel as a duplicate: it's the survivor, and cancelling it
    would take real visits off the calendar.

    Cancelled and ended rows are excluded entirely: somebody already decided
    about those, and a decided row is not a duplicate to resolve — it's
    history.
    """
    def _decided(s):
        end = coerce_date(s.series_end_date)
        return bool(getattr(s, "cancelled_at", None)) or (
            end is not None and end <= today and not s.active)

    candidates = [s for s in rows if not _decided(s)]
    buckets: Dict[Any, List[RecurringSchedule]] = {}
    for s in candidates:
        buckets.setdefault(_dup_bucket_key(s), []).append(s)

    groups: List[List[int]] = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        parent = {s.id: s.id for s in members}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        day_sets = {s.id: _effective_days(s.days_of_week, s.day_of_week, s.frequency)
                    for s in members}
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if a.frequency == "monthly" or (day_sets[a.id] & day_sets[b.id]):
                    ra, rb = find(a.id), find(b.id)
                    if ra != rb:
                        parent[ra] = rb
        clusters: Dict[int, List[RecurringSchedule]] = {}
        for s in members:
            clusters.setdefault(find(s.id), []).append(s)
        for cluster in clusters.values():
            if len(cluster) < 2:
                continue
            # Only the paused ones are offered for cancelling. A cluster of one
            # live series plus one paused copy is a real duplicate and yields
            # exactly one finding — on the paused row.
            paused = sorted(s.id for s in cluster if not _is_live(s, today))
            if not paused:
                continue
            live = sorted(s.id for s in cluster if _is_live(s, today))
            groups.append({"paused": paused, "live": live})
    return groups


def audit_series(db: Session, org_id: Optional[int]) -> dict:
    """Full health scan of the org's recurring series. Every problem carries a
    code, a human message, a suggested fix, and a ``destructive`` flag (the UI
    must escalate its confirm on those). Series with no problems are counted
    but not listed."""
    today = business_today()
    rows = db.query(RecurringSchedule).filter(
        or_(RecurringSchedule.org_id == org_id, RecurringSchedule.org_id.is_(None)),
    ).all()

    ids = [s.id for s in rows]
    counts: Dict[int, int] = {}
    if ids:
        counts = dict(
            db.query(Job.recurring_schedule_id, func.count(Job.id))
            .filter(
                Job.recurring_schedule_id.in_(ids),
                Job.status != "cancelled",
                or_(Job.scheduled_date == None, Job.scheduled_date >= today.isoformat()),  # noqa: E711
            )
            .group_by(Job.recurring_schedule_id)
            .all()
        )
    client_ids = {s.client_id for s in rows if s.client_id}
    client_names: Dict[int, str] = {}
    if client_ids:
        client_names = dict(
            db.query(Client.id, Client.name).filter(Client.id.in_(client_ids)).all()
        )
    prop_ids = {s.property_id for s in rows if s.property_id}
    live_prop_ids: Set[int] = set()
    if prop_ids:
        live_prop_ids = {pid for (pid,) in db.query(Property.id).filter(Property.id.in_(prop_ids)).all()}

    dup_groups = _group_live_duplicates(rows, today)
    in_dup_group = {sid for g in dup_groups for sid in g}

    paused_dup_groups = _group_paused_duplicates(rows, today)
    in_paused_dup = {sid: g for g in paused_dup_groups for sid in g["paused"]}

    issues = []
    for s in rows:
        problems = []
        live = _is_live(s, today)
        upcoming = counts.get(s.id, 0)
        end = coerce_date(s.series_end_date)
        title = (s.title or "").strip()

        # A series somebody DECIDED was over — cancelled, or past a recorded
        # end date — is not a to-do list. Owner report, with a screenshot: a
        # CANCELLED series was being flagged "no start/end time on file — visits
        # can't be scheduled at a real time". It will never schedule a visit.
        # Setting its time window is busywork this scan invented, and busywork
        # in a health check is why the count never appeared to go down.
        #
        # The findings below that describe how a series will MISBEHAVE WHEN IT
        # GENERATES are therefore skipped for a decided one.
        #
        # Two things are deliberately NOT decided. Paused, because a paused
        # series can come back and its problems come back with it. And
        # ended-but-still-ACTIVE, because that is half-decided — the office is
        # about to open it anyway (`ended_but_active` says so right below), and
        # hiding its other problems in the meantime just means finding them one
        # at a time afterwards.
        decided = bool(getattr(s, "cancelled_at", None)) or (
            end is not None and end <= today and not s.active)

        if s.id in in_paused_dup:
            group = in_paused_dup[s.id]
            others = [p for p in group["paused"] if p != s.id]
            if group["live"]:
                # The common shape after an "all future visits" edit: the live
                # series took over and this one was paused instead of ended.
                # There's no "which do I keep" question here — the running one
                # is the keeper by definition.
                message = ("A running series covers this same house and time — "
                           "this is the paused copy left behind.")
                suggestion = ("⚠️ Cancel it; the live one keeps going "
                              "(history is kept).")
            else:
                message = (f"One of {len(group['paused'])} paused copies of the "
                           "same series for this client.")
                suggestion = ("⚠️ Keep the one you'd resume and cancel the rest "
                              "(history is kept).")
            problems.append({
                "code": "duplicate_paused", "severity": "warn", "destructive": True,
                "message": message,
                "suggestion": suggestion,
                "partners": others,
                # True when a live series already covers this — the frontend
                # reads it to know there is no keeper to hold back.
                "has_live_copy": bool(group["live"]),
            })
        if s.id in in_dup_group:
            partners = next(g for g in dup_groups if s.id in g)
            problems.append({
                "code": "duplicate", "severity": "error", "destructive": False,
                "message": f"Looks identical to {len(partners) - 1} other live series for this client.",
                "suggestion": "Keep one and pause or cancel the rest (the duplicate review panel can walk through it).",
            })
        if s.client_id and s.client_id not in client_names:
            problems.append({
                "code": "orphaned_client", "severity": "error", "destructive": False,
                "message": "The client this series belongs to no longer exists.",
                "suggestion": "Cancel the series, or relink it to the right client.",
            })
        if not decided and (coerce_time(s.start_time) is None
                            or coerce_time(s.end_time) is None):
            problems.append({
                "code": "no_time_set", "severity": "error", "destructive": False,
                "message": "No start/end time on file — visits can't be scheduled at a real time.",
                "suggestion": "Edit the series and set its time window.",
            })
        if s.active and end is not None and end <= today:
            problems.append({
                "code": "ended_but_active", "severity": "warn", "destructive": False,
                "message": "This series already ended but is still marked active.",
                "suggestion": "Pause it so it stops showing as live (its history is kept).",
            })
        if live and upcoming == 0:
            problems.append({
                "code": "active_no_upcoming", "severity": "warn", "destructive": False,
                "message": "Marked active but has no upcoming visits generated.",
                "suggestion": "Generate visits, or check the rule (time window, days, end date).",
            })
        if not decided and (not title or len(title) < 4
                            or title.lower() in _JUNK_TITLES
                            or title.lower() == (s.frequency or "")):
            client = client_names.get(s.client_id)
            better = f"{client} — {_cadence_text(s)}" if client else _cadence_text(s)
            problems.append({
                "code": "junk_title", "severity": "warn", "destructive": False,
                "message": f"Title “{title or '(blank)'}” doesn't say whose clean this is.",
                "suggestion": f"Rename it, e.g. “{better}”.",
            })
        if decided:
            pass                      # see the `decided` comment above
        elif s.property_id and s.property_id not in live_prop_ids:
            problems.append({
                "code": "property_missing", "severity": "warn", "destructive": False,
                "message": "Points at a property that no longer exists.",
                "suggestion": "Relink the series to the client's current property.",
            })
        elif not s.property_id:
            problems.append({
                "code": "no_property", "severity": "info", "destructive": False,
                "message": "Not linked to a property (visits inherit only the free-text address).",
                "suggestion": "Link it to the client's property so visits, photos and access details connect.",
            })
        # "Leftover" means nobody ever decided this series was over — it just
        # stopped. A series that was CANCELLED, or that reached a recorded end
        # date, has its answer already and is not a to-do.
        #
        # Without those exclusions the fix could never clear the finding:
        # cancelling sets active=False (already false) and leaves `upcoming` at
        # zero, so the series still matched this rule and the scan reported the
        # same count forever. The suggestion below promised it "removes it from
        # the list" — a promise the code didn't keep, and the same shape as the
        # bug the owner reported about cancel not appearing to do anything.
        if not s.active and upcoming == 0 and not decided and s.id not in in_paused_dup:
            problems.append({
                "code": "stale_paused", "severity": "info", "destructive": True,
                "message": "Paused with nothing upcoming — likely a leftover.",
                "suggestion": "⚠️ Cancel it if it's never coming back (removes it from the list; history is kept).",
            })

        if problems:
            st = coerce_time(s.start_time)
            issues.append({
                "schedule_id": s.id,
                "title": s.title,
                "client_id": s.client_id,
                "client_name": client_names.get(s.client_id),
                "address": s.address,
                "property_id": s.property_id,
                "active": bool(s.active),
                "live": live,
                "cadence": _cadence_text(s),
                "start_time": f"{st.hour:02d}:{st.minute:02d}" if st is not None else None,
                "upcoming_job_count": upcoming,
                "problems": problems,
            })

    sev_rank = {"error": 0, "warn": 1, "info": 2}
    issues.sort(key=lambda i: min(sev_rank[p["severity"]] for p in i["problems"]))
    return {
        "scanned": len(rows),
        "healthy": len(rows) - len(issues),
        "duplicate_groups": dup_groups,
        # Paused copies of the same series. Kept separate from the live groups:
        # the fix is different (cancel the extras vs. pick a winner) and so is
        # the urgency.
        "paused_duplicate_groups": paused_dup_groups,
        "issues": issues,
    }
