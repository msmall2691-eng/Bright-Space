"""Autopilot level 3 — the standing rules, in one place and in plain language.

The business already ran on standing rules before this file existed. They were
just invisible: "text the customer 24 hours before" lived in an env var nobody
could reach from the app, "chase overdue invoices" lived on the Automation tab
under a messaging heading, "cover STR turnovers" lived under a scheduling one,
and "a turnover with nobody on it" only ever produced an ERROR line in a server
log the owner will never read.

This is the catalogue: one declarative list of the rules the business follows,
each stated the way she'd say it, with the settings that steer it. The UI
renders straight from it, so a rule added here shows up with no frontend
change, and there is exactly one wording of what each rule does.

WHAT THIS IS NOT: a rules engine. There's no condition builder and no DSL —
those buy a footgun and a support burden for a one-owner business. Each rule is
a behaviour the app already knows how to perform, with the one or two knobs
that actually vary.

HOW IT STAYS HONEST:
  - Values are read and written through the SAME app_setting keys the ticks
    already check (`get_setting` / `set_setting`), so nothing about how a rule
    executes changes when it moves into this list — the catalogue describes
    behaviour, it doesn't reimplement it.
  - A rule the deployment has hard-disabled by env reports `blocked` with the
    reason, instead of showing a switch that silently does nothing. That exact
    bug (a truthy DB setting reading as ON while the env flag held the tick
    off) is why messaging_status grew its `env_disabled` field.
  - Anything that reaches a customer or changes the schedule defaults to OFF or
    to 'propose'. The owner turns it up; it never turns itself up.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Field types the UI knows how to render. Keeping this closed is what lets the
# panel be generic — an unknown type would render as nothing at all.
FIELD_TYPES = ("bool", "choice", "number")

# Shared by every rule that can act on its own: park it for approval, or do it.
# 'propose' is the recommended middle and the default for anything that writes.
MODE_CHOICES = [
    {"value": "off", "label": "Off"},
    {"value": "propose", "label": "Ask me first"},
    {"value": "auto", "label": "Just do it"},
]


def _bool(value, default: bool) -> bool:
    """app_settings are TEXT; this is the same coercion modules/settings uses."""
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _env_hard_off(name: str) -> bool:
    """Only an explicit off value counts — unset means 'no opinion', not off.
    Delegates to the scheduler's parser so this can't drift from the gate the
    tick itself applies."""
    from scheduler import env_hard_off
    return env_hard_off(name)


# ── the catalogue ───────────────────────────────────────────────────────────
#
# `title` is the rule as the owner would say it out loud. `summary` is what
# actually happens, including the part she can't change. `fields` are the
# knobs; the first one is the rule's on/off or mode.

RULES: list[dict[str, Any]] = [
    {
        "key": "customer_reminder",
        "title": "Text the customer before their cleaning",
        "summary": "One text per cleaning, with the time and a link to confirm. "
                   "A customer is never texted twice for the same visit.",
        "env_gate": "JOB_SMS_REMINDERS_ENABLED",
        "fields": [
            {"key": "job_sms_reminders_enabled", "type": "bool", "default": False,
             "label": "Send the reminder"},
            {"key": "job_sms_reminder_lead_hours", "type": "number", "default": 12,
             "label": "How far ahead", "unit": "hours", "min": 1, "max": 168,
             "help": "12 means a morning cleaning is confirmed the evening "
                     "before. The check runs hourly, so the text lands within "
                     "an hour of this mark."},
        ],
    },
    {
        "key": "invoice_dunning",
        "title": "Chase overdue invoices",
        "summary": "Emails the customer at 1, 7 and 14 days past due, then stops. "
                   "Paying at any point ends the sequence.",
        "env_gate": "JOB_DUNNING_ENABLED",
        "fields": [
            {"key": "dunning_enabled", "type": "bool", "default": False,
             "label": "Send the reminders"},
        ],
    },
    {
        "key": "turnover_cover",
        "title": "Cover STR turnovers",
        "summary": "Picks an available cleaner for upcoming Airbnb/VRBO turnovers "
                   "that still have nobody on them.",
        "fields": [
            {"key": "str_auto_assign_mode", "type": "choice", "default": "off",
             "label": "When a turnover has no cleaner", "choices": MODE_CHOICES,
             "help": "“Ask me first” puts each pick on the Home board for you to "
                     "approve. “Just do it” assigns straight away."},
        ],
    },
    {
        "key": "crew_escalation",
        "title": "Offer a job to the crew when nobody's on it",
        "summary": "A scheduled job still has no cleaner as the date closes in, so "
                   "it goes on the crew's open-jobs board for someone to claim. "
                   "Access details stay hidden until it's claimed.",
        "fields": [
            {"key": "crew_escalation_mode", "type": "choice", "default": "propose",
             "label": "When a job is close with no cleaner", "choices": MODE_CHOICES,
             "help": "“Ask me first” puts it on the Home board so you decide "
                     "whether to open it up."},
            {"key": "crew_escalation_hours", "type": "number", "default": 24,
             "label": "How close", "unit": "hours", "min": 2, "max": 336,
             "help": "Measured to the start of the job. The check runs every "
                     "six hours, so an offer goes out within six hours of this "
                     "mark — set it a little wider than the notice you actually "
                     "want the crew to have."},
        ],
    },
    {
        "key": "autopilot_drafts",
        "title": "Draft my follow-ups",
        "summary": "When you open Home, Scout writes the replies you owe — "
                   "customers who texted and haven't heard back, quotes that have "
                   "gone quiet. Nothing sends without your tap.",
        "fields": [
            {"key": "autopilot_drafts_enabled", "type": "bool", "default": True,
             "label": "Write the drafts"},
        ],
    },
    {
        "key": "quote_expiry",
        "title": "Expire quotes that ran out",
        "summary": "A sent quote past its valid-until date is marked expired, so it "
                   "drops off the follow-up list and can't be accepted at a stale "
                   "price.",
        "fields": [
            {"key": "quote_auto_expire_enabled", "type": "bool", "default": True,
             "label": "Expire them automatically"},
        ],
    },
]

# Flat index of every settable field, for validation on save.
_FIELDS: dict[str, dict] = {f["key"]: f for rule in RULES for f in rule["fields"]}


def _read_field(db: Session, field: dict) -> Any:
    from modules.settings.router import get_setting

    raw = get_setting(db, field["key"])
    if field["type"] == "bool":
        return _bool(raw, field["default"])
    if field["type"] == "choice":
        allowed = {c["value"] for c in field["choices"]}
        value = (raw or "").strip().lower()
        return value if value in allowed else field["default"]
    # number
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return field["default"]


def list_rules(db: Session) -> dict:
    """The catalogue with the values currently in force.

    A rule whose deployment env flag is hard-off comes back `blocked` with the
    reason: its switch may read ON in the database and still not run, and
    showing that as a plain ON is a lie the owner would only discover when a
    customer says they never got the text."""
    out = []
    for rule in RULES:
        gate = rule.get("env_gate")
        blocked = _env_hard_off(gate) if gate else False
        out.append({
            "key": rule["key"],
            "title": rule["title"],
            "summary": rule["summary"],
            # Not "disabled": the setting is still hers to change, and it takes
            # effect the moment the deployment flag is lifted.
            "blocked": blocked,
            "blocked_reason": (
                f"Switched off at the deploy layer ({gate}=0). Your setting is "
                "kept and takes effect as soon as that's lifted."
            ) if blocked else None,
            "fields": [
                {**{k: v for k, v in f.items() if k != "default"},
                 "default": f["default"], "value": _read_field(db, f)}
                for f in rule["fields"]
            ],
        })
    return {"rules": out}


def save_rules(db: Session, patch: dict) -> dict:
    """Write the provided fields, validating each against its own definition.

    Unknown keys are refused rather than dropped: silently ignoring a setting
    the caller believed it saved is how someone ends up sure they turned
    customer texts off."""
    from fastapi import HTTPException
    from modules.settings.router import set_setting

    patch = dict(patch or {})
    unknown = [k for k in patch if k not in _FIELDS]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown rule setting(s): {', '.join(sorted(unknown))}")

    written = {}
    for key, value in patch.items():
        field = _FIELDS[key]
        if field["type"] == "bool":
            stored = "true" if _bool(value, False) else "false"
        elif field["type"] == "choice":
            allowed = {c["value"] for c in field["choices"]}
            candidate = str(value).strip().lower()
            if candidate not in allowed:
                raise HTTPException(
                    status_code=422,
                    detail=f"{key} must be one of {', '.join(sorted(allowed))}")
            stored = candidate
        else:  # number
            try:
                number = int(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=422,
                                    detail=f"{key} must be a whole number")
            # Clamping instead of erroring would quietly save something other
            # than what she typed, which for a lead time is a real behaviour
            # change she wouldn't see.
            if not (field["min"] <= number <= field["max"]):
                raise HTTPException(
                    status_code=422,
                    detail=f"{key} must be between {field['min']} and {field['max']}")
            stored = str(number)
        set_setting(db, key, stored)
        written[key] = stored

    db.commit()
    logger.info("[standing-rules] saved: %s", written)
    return list_rules(db)


# ── accessors the ticks use ─────────────────────────────────────────────────
#
# The rules that steer NEW behaviour read their setting through these, so the
# catalogue's default and the runtime default are the same value in one place.

def reminder_lead_hours(db: Session) -> int:
    """How far ahead of a cleaning the customer's text goes out.

    Was env-only (`JOB_SMS_REMINDER_LEAD_HOURS`), which meant the owner could
    turn reminders on and off from the app but not move them — the one thing
    about a reminder anyone actually wants to change. The env var stays as the
    fallback so an existing deployment keeps its configured value until she
    sets one in-app."""
    field = _FIELDS["job_sms_reminder_lead_hours"]
    from modules.settings.router import get_setting

    raw = get_setting(db, field["key"])
    if raw is None or not str(raw).strip():
        raw = os.getenv("JOB_SMS_REMINDER_LEAD_HOURS")
    try:
        hours = int(str(raw).strip())
    except (TypeError, ValueError):
        return field["default"]
    return hours if field["min"] <= hours <= field["max"] else field["default"]


def crew_escalation_mode(db: Session) -> str:
    return _read_field(db, _FIELDS["crew_escalation_mode"])


def crew_escalation_hours(db: Session) -> int:
    return _read_field(db, _FIELDS["crew_escalation_hours"])
