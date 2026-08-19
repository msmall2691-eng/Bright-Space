"""
Ops Board aggregation — the data behind the iOS-style triage dashboard.

The board groups everything that needs the operator's attention into seven
sections (Today's Schedule, Needs You Today, Jobs on Deck, Money, Real People
Waiting, Systems & Subscriptions, Safe to Ignore), a row of stat tiles, a
strip of integration status chips, and per-severity filter counts. This
module does all of that in one pass so `GET /api/dashboard/board` is a single
round trip and the frontend stays a pure view (every string here is
render-ready).

Each card carries an `actions` list. A `link` action just navigates; an `api`
action calls an existing endpoint (mark paid, auto-assign, resolve) straight
from the board — see the `_api` helper and the frontend BoardRow handler.

Phase 1 (this file): live BrightBase data + integration health. The "Safe to
Ignore" section and the SaaS-notice rows in "Systems" are filled by the Gmail
triage layer in a later phase; they degrade to empty here.

Everything is org-scoped with the same `or_(org_id == oid, org_id IS NULL)`
predicate the rest of the dashboard uses (tolerates legacy NULL-org rows).
"""
from __future__ import annotations

import os
from datetime import datetime, date, time, timedelta, timezone

from sqlalchemy import or_, func
from sqlalchemy.orm import Session, joinedload

import config
from database.models import (
    Client, Job, Invoice, Quote, LeadIntake, RecurringSchedule,
    Conversation, Message, IntegrationEvent, AppSetting, UserGoogleAccount,
    InboxTriageItem,
)
from utils.dates import (
    business_today, business_tz, add_business_minutes, coerce_date, coerce_time,
)
from integrations.google_accounts import gmail_accounts, calendar_account

# Per-section item caps — the board is a triage surface, not a full list. Each
# card deep-links into the page that owns the full set.
_CAP = 6

# Severity vocabulary (matches the frontend filter chips). Ordered most- to
# least-urgent so a section sorts cleanly.
_SEVERITY_ORDER = ["urgent", "watch", "info", "good", "recurring"]


# ── SLA (mirrors modules.comms.router._sla_state) ───────────────────────────
# Kept in sync via the shared business-hours clock (utils.dates) and the same
# SLA_FRT_* env vars, so a breached card here matches the inbox exactly.
_FRT_MINUTES = {
    "urgent": int(os.getenv("SLA_FRT_URGENT", "30")),
    "high": int(os.getenv("SLA_FRT_HIGH", "120")),
    "normal": int(os.getenv("SLA_FRT_NORMAL", "480")),
    "low": int(os.getenv("SLA_FRT_LOW", "960")),
}


def _as_utc(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _sla_state(conv: Conversation) -> str:
    """none | met | on_track | at_risk | breached — recomputed live."""
    inbound = _as_utc(conv.last_inbound_at)
    if inbound is not None:
        frt = _FRT_MINUTES.get(conv.priority or "normal", 480)
        deadline = _as_utc(add_business_minutes(inbound, frt))
    else:
        deadline = _as_utc(conv.sla_deadline)
    if not deadline:
        return "none"
    first = _as_utc(conv.first_response_at)
    if first and first <= deadline:
        return "met"
    now = datetime.now(timezone.utc)
    if now > deadline:
        return "breached"
    if (deadline - now).total_seconds() < 30 * 60:
        return "at_risk"
    return "on_track"


# ── Actions ─────────────────────────────────────────────────────────────────

def _link(label: str, href: str) -> dict:
    return {"label": label, "kind": "link", "href": href}


def _api(label: str, endpoint: str, *, body=None, confirm=None, done=None, clears=True) -> dict:
    """A one-click action that POSTs to an existing endpoint from the board."""
    a = {"label": label, "kind": "api", "method": "POST", "endpoint": endpoint, "clears": clears}
    if body is not None:
        a["body"] = body
    if confirm:
        a["confirm"] = confirm
    if done:
        a["done"] = done
    return a


# ── Formatting helpers (render-ready output) ────────────────────────────────

def _fmt_money(n) -> str:
    return "$" + f"{float(n or 0):,.2f}"


def _fmt_money_compact(n) -> str:
    v = round(float(n or 0))
    a = abs(v)
    if a >= 1_000_000:
        return f"${v / 1_000_000:.1f}M"
    if a >= 10_000:
        return f"${round(v / 1000)}K"
    return f"${v:,}"


def _fmt_time(t) -> str:
    t = coerce_time(t)
    if not t:
        return ""
    h = t.hour % 12 or 12
    ampm = "a" if t.hour < 12 else "p"
    return f"{h}:{t.minute:02d}{ampm}" if t.minute else f"{h}{ampm}"


def _day_label(d, today: date) -> str:
    d = coerce_date(d)
    if not d:
        return ""
    delta = (d - today).days
    if delta == 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    if delta == -1:
        return "yesterday"
    if 0 < delta < 7:
        return d.strftime("%a")
    if -7 < delta < 0:
        return f"{-delta}d ago"
    return f"{d.strftime('%b')} {d.day}"


def _ago(dt) -> str:
    dt = _as_utc(dt)
    if not dt:
        return ""
    secs = (datetime.now(timezone.utc) - dt).total_seconds()
    if secs < 0:
        return "just now"
    days = int(secs // 86400)
    if days <= 0:
        hrs = int(secs // 3600)
        return f"{hrs}h ago" if hrs >= 1 else "just now"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days}d ago"
    weeks = days // 7
    return f"{weeks}w ago" if weeks < 5 else f"{days // 30}mo ago"


def _job_meta(job: Job, today: date) -> str:
    day = _day_label(job.scheduled_date, today)
    st, et = _fmt_time(job.start_time), _fmt_time(job.end_time)
    span = f"{st}–{et}" if st and et else st
    return " · ".join(x for x in (day, span) if x)


def _turnover_context(job: Job) -> str:
    """For STR turnover jobs: the checkout→check-in window plus a quick
    access cue (door code), so a crew scanning the board can see how tight
    the flip is and how to get in without opening the job detail. Reads off
    `job.property`, which the deck's query already joinedload()s — no extra
    query. Returns "" for non-turnover jobs or properties missing the data
    (residential/commercial jobs, or an STR property that hasn't been filled
    in yet — never renders a misleading partial line)."""
    if (job.job_type or "").lower() != "str_turnover":
        return ""
    prop = job.property
    if not prop:
        return ""
    parts = []
    if prop.check_out_time or prop.check_in_time:
        co = prop.check_out_time or "?"
        ci = prop.check_in_time or "?"
        parts.append(f"Out {co} → In {ci}")
    if prop.house_code:
        parts.append(f"Code {prop.house_code}")
    return " · ".join(parts)


def _job_type_tag(job: Job) -> dict:
    jt = (job.job_type or "").lower()
    if jt == "str_turnover":
        return {"label": "Turnover", "tone": "blue"}
    if jt == "commercial":
        return {"label": "Commercial", "tone": "violet"}
    return {"label": "Residential", "tone": "indigo"}


def _job_place(job: Job) -> str:
    p = getattr(job, "property", None)
    if p:
        return p.name or p.address or ""
    return job.address or (job.title or "")


def _client_name(obj) -> str:
    c = getattr(obj, "client", None)
    if c and c.name:
        return c.name
    return ""


def _cadence_label(sched: RecurringSchedule) -> str:
    freq = (sched.frequency or "").lower()
    iw = sched.interval_weeks or 1
    if freq == "monthly":
        return "monthly"
    if freq == "weekly" or iw == 1:
        return "weekly"
    if freq == "biweekly" or iw == 2:
        return "every 2 weeks"
    return f"every {iw} weeks"


# ── Low-level reads ─────────────────────────────────────────────────────────

def _setting(db: Session, key: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else None


def _today_start_utc(today: date) -> datetime:
    """Naive-UTC datetime for the start of the business day (matches how
    Invoice.paid_at is stored)."""
    local = datetime.combine(today, time.min, tzinfo=business_tz())
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def _item(id, severity, title, body="", meta="", tags=None, actions=None, source="brightbase"):
    return {
        "id": id,
        "severity": severity,
        "title": title,
        "body": body,
        "meta": meta,
        "tags": tags or [],
        "actions": actions or [],
        "source": source,
    }


def _sort_items(items: list) -> list:
    rank = {s: i for i, s in enumerate(_SEVERITY_ORDER)}
    return sorted(items, key=lambda it: rank.get(it["severity"], 99))


# ── The build ───────────────────────────────────────────────────────────────

def build_board(db: Session, oid: int, can_act: bool = True) -> dict:
    today = business_today()
    week_end = today + timedelta(days=7)
    horizon = today + timedelta(days=14)
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    # --- Jobs (next two weeks) ----------------------------------------------
    jobs = (
        db.query(Job)
        .options(joinedload(Job.property), joinedload(Job.client))
        .filter(
            org(Job),
            Job.scheduled_date >= today,
            Job.scheduled_date <= horizon,
            Job.status.in_(("scheduled", "in_progress")),
        )
        .order_by(Job.scheduled_date, Job.start_time)
        .all()
    )

    def _is_unassigned(j):
        return not (j.cleaner_ids or [])

    def _is_weekend(d):
        d = coerce_date(d)
        return d is not None and d.weekday() >= 5

    today_jobs = [j for j in jobs if coerce_date(j.scheduled_date) == today]
    week_jobs = [j for j in jobs if (coerce_date(j.scheduled_date) or horizon) <= week_end]
    weekend_jobs = [j for j in week_jobs if _is_weekend(j.scheduled_date)]
    unassigned_week = [j for j in week_jobs if _is_unassigned(j)]
    unassigned_urgent = [
        j for j in unassigned_week
        if coerce_date(j.scheduled_date) == today or _is_weekend(j.scheduled_date)
    ]

    # --- Conversations (open) -----------------------------------------------
    open_convs = (
        db.query(Conversation)
        .options(joinedload(Conversation.client))
        .filter(org(Conversation), Conversation.status == "open")
        .order_by(Conversation.last_inbound_at.desc().nullslast())
        .limit(40)
        .all()
    )
    waiting = [c for c in open_convs if c.last_inbound_at is not None and c.first_response_at is None]
    for c in waiting:
        c._sla = _sla_state(c)  # type: ignore[attr-defined]
    breached = [c for c in waiting if c._sla == "breached"]
    still_waiting = [c for c in waiting if c._sla != "breached"]

    show_conv_ids = [c.id for c in (breached[:_CAP] + still_waiting[:_CAP])]
    snippets: dict[int, str] = {}
    if show_conv_ids:
        msgs = (
            db.query(Message)
            .filter(Message.conversation_id.in_(show_conv_ids), Message.direction == "inbound")
            .order_by(Message.created_at.desc())
            .all()
        )
        for m in msgs:
            snippets.setdefault(m.conversation_id, (m.body or "").strip().replace("\n", " ")[:120])

    def _conv_contact(c):
        return _client_name(c) or c.external_contact or (c.subject or "Conversation")

    # --- Invoices ------------------------------------------------------------
    outstanding_rows = (
        db.query(Invoice)
        .options(joinedload(Invoice.client))
        .filter(org(Invoice), Invoice.status.in_(("sent", "overdue")))
        .all()
    )
    outstanding_total = sum(r.total or 0 for r in outstanding_rows)
    overdue_rows = [r for r in outstanding_rows if r.status == "overdue"]
    overdue_rows.sort(key=lambda r: coerce_date(r.due_date) or today)

    collected_today = (
        db.query(func.coalesce(func.sum(Invoice.total), 0.0))
        .filter(
            org(Invoice),
            Invoice.status == "paid",
            Invoice.paid_at.isnot(None),
            Invoice.paid_at >= _today_start_utc(today),
        )
        .scalar()
    ) or 0.0

    last_paid = (
        db.query(Invoice)
        .options(joinedload(Invoice.client))
        .filter(org(Invoice), Invoice.status == "paid", Invoice.paid_at.isnot(None))
        .order_by(Invoice.paid_at.desc())
        .first()
    )

    # --- Quote follow-ups (waiting on the customer) --------------------------
    follow_ups = (
        db.query(Quote)
        .options(joinedload(Quote.client))
        .filter(org(Quote), Quote.status.in_(("sent", "viewed")))
        .order_by(Quote.sent_at.asc().nullslast())
        .limit(_CAP)
        .all()
    )

    # --- Leads needing action ------------------------------------------------
    leads = (
        db.query(LeadIntake)
        .filter(org(LeadIntake), LeadIntake.status.in_(("new", "reviewed")))
        .order_by(LeadIntake.created_at.desc())
        .limit(10)
        .all()
    )

    # --- Active recurring ----------------------------------------------------
    recurring = (
        db.query(RecurringSchedule)
        .options(joinedload(RecurringSchedule.client))
        .filter(org(RecurringSchedule), RecurringSchedule.active.is_(True))
        .order_by(RecurringSchedule.created_at.desc())
        .limit(_CAP)
        .all()
    )

    # ========================================================================
    #  Assemble sections
    # ========================================================================

    # ── 🔴 Needs You Today ──────────────────────────────────────────────────
    needs = []
    for j in unassigned_urgent[:_CAP]:
        needs.append(_item(
            f"job:{j.id}", "urgent", "No cleaner assigned",
            f"{_job_place(j)}" + (f" · {_client_name(j)}" if _client_name(j) else ""),
            _job_meta(j, today),
            # Just the type tag — the row's TITLE is already 'No cleaner
            # assigned'; a second UNASSIGNED chip said it twice (owner veto).
            tags=[_job_type_tag(j)],
            actions=[
                _api("Auto-assign", f"/api/jobs/{j.id}/auto-assign", done="Assigned"),
                _link("Dispatch", "/schedule?view=dispatch"),
            ],
        ))
    for c in breached[:_CAP]:
        needs.append(_item(
            f"conv:{c.id}", "urgent", f"Reply overdue — {_conv_contact(c)}",
            snippets.get(c.id, "") or (c.subject or f"{(c.channel or 'message').upper()} awaiting reply"),
            _ago(c.last_inbound_at),
            tags=[{"label": (c.channel or "message").capitalize(), "tone": "rose"}],
            actions=[
                _api("Resolve", f"/api/comms/conversations/{c.id}/status", body={"status": "resolved"}, done="Resolved"),
                # BB-CODE-03: this used to link to bare "/comms" — no conversation
                # id — so "Reply" always landed on the inbox list, not the
                # specific thread (owner: "it doesn't really direct me to
                # reply"). Comms.jsx now reads ?conversation= on mount and
                # opens that thread directly.
                _link("Reply", f"/comms?conversation={c.id}"),
            ],
        ))
    for q in follow_ups:
        stage = "viewed, not accepted" if q.viewed_at else "sent, not opened"
        needs.append(_item(
            f"quote:{q.id}", "info", f"Quote nudge — {_client_name(q) or (q.title or 'Quote')}",
            f"{_fmt_money(q.total)} · {stage}", _ago(q.viewed_at or q.sent_at),
            tags=[{"label": "QUOTE", "tone": "indigo"}],
            actions=[_link("Open", "/billing?view=quotes")],
        ))

    # ── 📅 Today's Schedule ──────────────────────────────────────────────────
    # A chronological rundown of the day's visits — reuses `today_jobs`
    # (already fetched above for `unassigned_urgent`; no extra query). The
    # board previously had no "what does today look like" view at all, only
    # unassigned-jobs triage and a forward-looking "Jobs on Deck" list; the
    # owner asked for the schedule itself to be glanceable on Home. Kept in
    # time order (not `_sort_items`'d by severity) — the point is "what's
    # next", not "what's most broken".
    todays_schedule = []
    for j in today_jobs:
        assigned = not _is_unassigned(j)
        todays_schedule.append(_item(
            f"today-job:{j.id}", "good" if assigned else "watch",
            _job_place(j) or (j.title or f"Job #{j.id}"), _client_name(j), _job_meta(j, today),
            tags=[_job_type_tag(j)] + ([] if assigned else [{"label": "Needs cleaner", "tone": "amber"}]),
            actions=[_link("View", f"/jobs/{j.id}")],
        ))

    # ── 🧹 Jobs on Deck ─────────────────────────────────────────────────────
    deck = []
    for j in week_jobs[:_CAP]:
        assigned = not _is_unassigned(j)
        acts = [_link("View", f"/jobs/{j.id}")]
        if not assigned:
            acts.insert(0, _api("Auto-assign", f"/api/jobs/{j.id}/auto-assign", done="Assigned", clears=False))
        # STR turnovers get a checkout→check-in + door-code line appended to
        # meta so the flip window and access are visible at a glance, not
        # just in the job detail drawer.
        meta = _job_meta(j, today)
        turno = _turnover_context(j)
        if turno:
            meta = f"{meta} · {turno}" if meta else turno
        deck.append(_item(
            f"deck-job:{j.id}", "good" if assigned else "watch",
            _job_place(j) or (j.title or f"Job #{j.id}"), _client_name(j), meta,
            tags=[_job_type_tag(j)] + ([] if assigned else [{"label": "Needs cleaner", "tone": "amber"}]),
            actions=acts,
        ))
    for s in recurring:
        deck.append(_item(
            f"recurring:{s.id}", "recurring", s.title or "Recurring clean",
            (_client_name(s) or s.address or "") + f" · {_cadence_label(s)}", "",
            tags=[{"label": "RECURRING", "tone": "emerald"}],
            actions=[_link("Series", "/recurring")],
        ))

    # ── 💵 Money ─────────────────────────────────────────────────────────────
    money = []
    if collected_today > 0:
        money.append(_item(
            "money:collected", "good", "Collected today", _fmt_money(collected_today), "",
            tags=[{"label": "PAID", "tone": "emerald"}],
            actions=[_link("Billing", "/billing?view=invoices")],
        ))
    if outstanding_total > 0:
        n = len(outstanding_rows)
        money.append(_item(
            "money:outstanding", "watch", f"{_fmt_money(outstanding_total)} outstanding",
            f"across {n} invoice{'s' if n != 1 else ''}" + (f" · {len(overdue_rows)} overdue" if overdue_rows else ""),
            "", tags=[{"label": "AR", "tone": "amber"}],
            actions=[_link("Chase", "/billing?view=invoices&status=overdue")],
        ))
    for inv in overdue_rows[:4]:
        days_over = ""
        due = coerce_date(inv.due_date)
        if due:
            od = (today - due).days
            days_over = f"{od}d overdue" if od > 0 else "due today"
        money.append(_item(
            f"invoice:{inv.id}", "watch", f"{inv.invoice_number or 'Invoice'} — {_client_name(inv) or 'client'}",
            f"{_fmt_money(inv.total)}" + (f" · {days_over}" if days_over else ""), "",
            tags=[{"label": "OVERDUE", "tone": "rose"}],
            actions=[
                _api("Mark paid", f"/api/invoices/{inv.id}/pay", body={}, confirm="Mark this invoice paid?", done="Paid"),
                _link("Open", "/billing?view=invoices&status=overdue"),
            ],
        ))
    if last_paid:
        money.append(_item(
            f"paid:{last_paid.id}", "good", f"Last payment — {_fmt_money(last_paid.total)}",
            _client_name(last_paid) or (last_paid.invoice_number or ""), _ago(last_paid.paid_at),
            tags=[{"label": "PAID", "tone": "emerald"}],
            actions=[_link("Billing", "/billing?view=invoices")],
        ))

    # ── ✉️ Real People Waiting ──────────────────────────────────────────────
    people = []
    for c in still_waiting[:_CAP]:
        sev = "watch" if c._sla == "at_risk" else "info"
        people.append(_item(
            f"wait-conv:{c.id}", sev, _conv_contact(c),
            snippets.get(c.id, "") or (c.subject or f"{(c.channel or 'message').upper()} — awaiting your reply"),
            _ago(c.last_inbound_at),
            tags=[{"label": (c.channel or "msg").upper(), "tone": "blue"}],
            actions=[_link("Reply", f"/comms?conversation={c.id}")],  # BB-CODE-03 — see above
        ))
    for ld in leads[:_CAP]:
        hot = (ld.priority or "normal") in ("high", "urgent")
        svc = (ld.service_type or "").upper() or "LEAD"
        people.append(_item(
            f"lead:{ld.id}", "watch" if hot else "info", f"New lead — {ld.name or 'inquiry'}",
            (ld.message or ld.requested_service or ld.address or "Wants a quote").strip()[:120], _ago(ld.created_at),
            tags=[{"label": svc, "tone": "indigo"}] + ([{"label": "HOT", "tone": "rose"}] if hot else []),
            actions=[_link("Quote", "/requests")],
        ))

    # ── 🧰 Systems & Subscriptions (integration health) ─────────────────────
    integrations, systems = _integration_health(db, oid, today)

    # Cheap "Tidy Up" nudge — clients sharing a phone (indexed phone_tail) are
    # likely duplicates. The full scan (clients/properties/quality) lives at
    # /api/cleanup/scan; this just surfaces the count without the heavy pass.
    dup_groups = (
        db.query(func.count())
        .select_from(
            db.query(Client.phone_tail)
            .filter(org(Client), Client.phone_tail.isnot(None), Client.phone_tail != "")
            .group_by(Client.phone_tail)
            .having(func.count(Client.id) > 1)
            .subquery()
        )
        .scalar()
    ) or 0
    if dup_groups:
        systems.append(_item(
            "sys:duplicates", "watch",
            f"{dup_groups} possible duplicate client{'s' if dup_groups != 1 else ''}",
            "Same phone on more than one record — review and merge.", "",
            tags=[{"label": "CLEANUP", "tone": "violet"}],
            actions=[_link("Tidy Up", "/cleanup")],
        ))

    # ── 🧰 SaaS notices + 🗑️ Safe to Ignore (Gmail triage) ──────────────────
    # The automated inbound-email stream, captured + classified by the sync
    # (services/inbox_triage). SaaS/billing/security notices reinforce Systems;
    # promotions/social/newsletters fill Safe to Ignore.
    triage_systems, safe = _inbox_triage(db, oid, today)
    systems.extend(triage_systems)

    sections = [
        {"key": "today_schedule", "title": "Today's Schedule", "icon": "📅", "items": todays_schedule},
        {"key": "needs_today", "title": "Needs You Today", "icon": "🔴", "items": _sort_items(needs)},
        {"key": "jobs_on_deck", "title": "Jobs on Deck", "icon": "🧹", "items": _sort_items(deck)},
        {"key": "money", "title": "Money", "icon": "💵", "items": _sort_items(money)},
        {"key": "people_waiting", "title": "Real People Waiting", "icon": "✉️", "items": _sort_items(people)},
        {"key": "systems", "title": "Systems & Subscriptions", "icon": "🧰", "items": _sort_items(systems)},
        {"key": "safe_to_ignore", "title": "Safe to Ignore", "icon": "🗑️", "items": safe},
    ]

    # A read-only role (viewer/cleaner/client) sees the board but can't fire
    # write actions from it — strip the one-click `api` actions server-side so
    # the endpoint is the enforcement point, not just the UI. `link` actions
    # (plain navigation) always stay.
    if not can_act:
        for sec in sections:
            for it in sec["items"]:
                it["actions"] = [a for a in it["actions"] if a.get("kind") != "api"]

    # --- Filter counts (per severity, across every section) ------------------
    filters = {"all": 0, "urgent": 0, "watch": 0, "info": 0, "good": 0, "recurring": 0}
    for sec in sections:
        for it in sec["items"]:
            filters["all"] += 1
            filters[it["severity"]] = filters.get(it["severity"], 0) + 1

    # --- Stat tiles ----------------------------------------------------------
    waiting_count = len(waiting)
    new_leads_count = sum(1 for ld in leads if (ld.status or "new") == "new")
    stats = [
        {"key": "unassigned", "label": "Unassigned jobs", "value": str(len(unassigned_week)),
         "sub": "next 7 days", "tone": "red" if unassigned_week else "neutral", "href": "/schedule?view=dispatch"},
        {"key": "weekend", "label": "This weekend", "value": str(len(weekend_jobs)),
         "sub": "jobs booked", "tone": "amber" if weekend_jobs else "neutral", "href": "/schedule"},
        {"key": "overdue", "label": "Overdue", "value": str(len(overdue_rows)),
         "sub": "invoices past due", "tone": "red" if overdue_rows else "neutral", "href": "/billing?view=invoices&status=overdue"},
        {"key": "waiting", "label": "People waiting", "value": str(waiting_count),
         "sub": f"{len(breached)} past SLA" if breached else "awaiting reply",
         "tone": "red" if breached else ("amber" if waiting_count else "neutral"), "href": "/comms"},
        {"key": "leads", "label": "New leads", "value": str(new_leads_count),
         "sub": "to quote", "tone": "amber" if new_leads_count else "neutral", "href": "/requests"},
        {"key": "collected", "label": "Collected today", "value": _fmt_money_compact(collected_today),
         "sub": "payments in", "tone": "money", "href": "/billing?view=invoices"},
    ]

    company_name = _setting(db, "company_name") or getattr(config, "DEFAULT_COMPANY_NAME", "Ops Board")
    company_email = _setting(db, "company_email") or _setting(db, "smtp_user") or None

    return {
        "company": company_name,
        "email": company_email,
        "refreshed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "stats": stats,
        "integrations": integrations,
        "filters": filters,
        "sections": sections,
    }


# ── Inbox triage (Gmail) ─────────────────────────────────────────────────────

# category → tag tone (must be a TAG_TONE key: rose/amber/emerald/blue/indigo/violet/gray).
_TRIAGE_TONE = {
    "security": "rose", "finance": "amber", "saas": "violet",
    "promotions": "gray", "social": "blue", "updates": "gray", "other": "gray",
}


def _gmail_link(message_id):
    """A Gmail deep link that opens the exact message by its RFC Message-ID."""
    mid = (message_id or "").strip().strip("<>")
    if not mid:
        return None
    from urllib.parse import quote
    return f"https://mail.google.com/mail/u/0/#search/rfc822msgid:{quote(mid)}"


def _triage_card(r, today: date) -> dict:
    sev = "watch" if r.category == "security" else "info"
    title = (r.vendor or r.from_name or r.from_addr or "Notice").strip()
    if r.category == "security":
        title = f"{title} — security"
    elif r.category == "finance":
        title = f"{title} — billing"
    body = (r.subject or "").strip() or (r.snippet or "").strip()
    tags = [{"label": (r.category or "other").upper(), "tone": _TRIAGE_TONE.get(r.category, "gray")}]
    # "Delete" trashes the email in Gmail (when the account granted it) and
    # tombstones the card so it never resurfaces; board-only fallback otherwise.
    actions = [_api("Delete", f"/api/inbox/triage/{r.id}/delete", body={}, done="Deleted")]
    link = _gmail_link(r.external_id)
    if link:
        actions.append(_link("Open in Gmail", link))
    if r.unsubscribe_url:
        actions.append(_link("Unsubscribe", r.unsubscribe_url))
    return _item(f"triage:{r.id}", sev, title, body, _ago(r.received_at),
                 tags=tags, actions=actions, source="gmail")


def _inbox_triage(db: Session, oid: int, today: date, cap: int = _CAP):
    """Board cards for the captured automated-email stream, split into the
    Systems (SaaS/billing/security notices) and Safe-to-Ignore (promotions,
    social, newsletters) buckets. Returns (systems_items, safe_items).

    Org-scoped and dismissed rows are hidden. Newest first; each bucket capped."""
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))
    rows = (
        db.query(InboxTriageItem)
        .filter(org(InboxTriageItem), InboxTriageItem.dismissed_at.is_(None))
        .order_by(InboxTriageItem.received_at.desc().nullslast(),
                  InboxTriageItem.id.desc())
        .limit(cap * 4)
        .all()
    )
    systems, safe = [], []
    for r in rows:
        if r.section == "systems":
            if len(systems) < cap:
                systems.append(_triage_card(r, today))
        elif len(safe) < cap:
            safe.append(_triage_card(r, today))
    return systems, safe


# ── Integration health ──────────────────────────────────────────────────────

def _integration_health(db: Session, oid: int, today: date):
    """Returns (chips, system_items). Chips are the status strip; system_items
    are the actionable cards (only integrations that need attention, plus recent
    delivery failures) for the Systems & Subscriptions section.

    Org-scoped: the Gmail/Calendar account counts and the delivery-failure count
    are restricted to this tenant (tolerating legacy NULL-org rows), so one
    org's board never reports another org's connected accounts or failures."""
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))
    chips = []
    systems = []

    connected = gmail_accounts(db, oid)
    expired = (
        db.query(func.count(UserGoogleAccount.id))
        .filter(org(UserGoogleAccount),
                UserGoogleAccount.gmail_sync_enabled.is_(True), UserGoogleAccount.status != "connected")
        .scalar()
    ) or 0
    if connected:
        chips.append({"key": "gmail", "label": "Gmail", "status": "connected",
                      "detail": f"{len(connected)} account{'s' if len(connected) != 1 else ''}", "tone": "green"})
    elif expired:
        chips.append({"key": "gmail", "label": "Gmail", "status": "warn", "detail": "reconnect", "tone": "amber"})
    else:
        chips.append({"key": "gmail", "label": "Gmail", "status": "off", "detail": "not connected", "tone": "gray"})
    if expired:
        systems.append(_item(
            "sys:gmail", "watch", "Gmail needs reconnecting",
            f"{expired} connected account{'s' if expired != 1 else ''} expired or revoked — inbound email won't sync.",
            "", tags=[{"label": "AUTH", "tone": "amber"}],
            actions=[_link("Reconnect", "/settings")], source="integration",
        ))

    cal = calendar_account(db, oid) or _setting(db, "google_token")
    chips.append({"key": "calendar", "label": "Calendar", "status": "connected" if cal else "off",
                  "detail": "synced" if cal else "not connected", "tone": "green" if cal else "gray"})

    for key, label, setting in (
        ("square", "Square", "square_access_token"),
    ):
        on = bool(_setting(db, setting))
        chips.append({"key": key, "label": label, "status": "connected" if on else "off",
                      "detail": "configured" if on else "not set", "tone": "green" if on else "gray"})

    twilio_on = bool(os.getenv("TWILIO_ACCOUNT_SID"))
    chips.append({"key": "twilio", "label": "Twilio", "status": "connected" if twilio_on else "off",
                  "detail": "configured" if twilio_on else "not set", "tone": "green" if twilio_on else "gray"})

    since = datetime.now(timezone.utc) - timedelta(days=7)
    failed = (
        db.query(func.count(IntegrationEvent.id))
        .filter(org(IntegrationEvent), IntegrationEvent.status == "failed", IntegrationEvent.created_at >= since)
        .scalar()
    ) or 0
    if failed:
        systems.append(_item(
            "sys:failed-sends", "watch", f"{failed} delivery failure{'s' if failed != 1 else ''}",
            "Emails, texts or calendar pushes failed to send in the last 7 days.", "",
            tags=[{"label": "DELIVERY", "tone": "rose"}],
            actions=[_link("Review", "/settings")], source="integration",
        ))

    return chips, systems
