"""AI assistant REST endpoints.

These back three frontend features that were already shipped in the UI but had
no server behind them (the buttons were dead):

  - POST /api/ai/quick          — the Cmd+K "Ask AI" command bar
  - GET  /api/ai/daily-briefing — the dashboard's morning briefing
  - GET  /api/ai/followup-check — the "needs attention" alert list

`quick` and `daily-briefing` use the Anthropic client plus the existing
read-only business tools (agents/tools.py), so the assistant can pull live data
(jobs, clients, invoices) before answering. Both degrade gracefully when
ANTHROPIC_API_KEY is unset.

`followup-check` is intentionally deterministic — no LLM. The UI hits it on
every command-bar open and on dashboard mount, so it must be fast, free, and
return a stable shape. It's a direct DB scan for the things an owner actually
needs nudging about (overdue invoices, unassigned jobs, etc.).
"""
import json
import logging
import os
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Client, Job, RecurringSchedule, Property, Invoice
from modules.auth.router import get_current_user
from agents.tools import get_tools_for_agent, execute_tool

logger = logging.getLogger(__name__)
router = APIRouter()

MODEL = "claude-sonnet-4-6"
# Business agent persona reused for the snapshot tools (read-only).
_AGENT = "nova"


class QuickQuery(BaseModel):
    question: str
    page_context: Optional[str] = None


def _anthropic_client():
    """Return an Anthropic client, or None if the key/SDK isn't available."""
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        import anthropic
        return anthropic.Anthropic(api_key=key)
    except Exception as e:  # pragma: no cover - import/config guard
        logger.warning("Anthropic client unavailable: %s", e)
        return None


def _run_tool_loop(client, system: str, user_content: str, *, max_tokens: int = 1024,
                   max_iters: int = 5) -> str:
    """Run a bounded agentic loop: let the model call the read-only business
    tools until it produces a final text answer. Returns the text."""
    tools = get_tools_for_agent(_AGENT)
    messages = [{"role": "user", "content": user_content}]
    for _ in range(max_iters):
        resp = client.messages.create(
            model=MODEL, max_tokens=max_tokens, system=system,
            messages=messages, tools=tools,
        )
        if resp.stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": resp.content})
            results = []
            for block in resp.content:
                if block.type == "tool_use":
                    out = execute_tool(block.name, dict(block.input), _AGENT)
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(out, default=str),
                    })
            messages.append({"role": "user", "content": results})
            continue
        # Final answer
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    # Hit the iteration cap — return whatever text we have
    return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()


def _strip_json(text: str) -> str:
    """Pull a JSON object out of a model response that may be fenced."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```", 2)[1] if "```" in t[3:] else t[3:]
        if t.startswith("json"):
            t = t[4:]
    start, end = t.find("{"), t.rfind("}")
    return t[start:end + 1] if start != -1 and end != -1 else t


# ── POST /api/ai/quick ──────────────────────────────────────────────────────

@router.post("/quick")
def quick_query(body: QuickQuery, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    """One-shot question answered with live business data. Returns {answer}."""
    client = _anthropic_client()
    if client is None:
        return {"answer": "The AI assistant isn't configured yet (missing "
                          "ANTHROPIC_API_KEY). I can still help once it's set up.",
                "error": True}

    page = (body.question or "").strip()
    if not page:
        return {"answer": "Ask me something about your business — jobs, clients, "
                          "invoices, or what needs attention today.", "error": False}

    system = (
        "You are the BrightBase assistant for a cleaning business. Answer the "
        "owner's question concisely and directly (2-4 sentences, or a short "
        "list). Use the available tools to look up live data before answering — "
        "never invent numbers. If a question can't be answered from the data, "
        "say so briefly."
    )
    ctx = f"[Current page: {body.page_context}]\n\n" if body.page_context else ""
    try:
        answer = _run_tool_loop(client, system, f"{ctx}{body.question.strip()}")
        return {"answer": answer or "I couldn't find an answer to that.",
                "error": False}
    except Exception as e:
        logger.exception("ai/quick failed")
        return {"answer": f"Sorry, I hit an error: {e}", "error": True}


# ── GET /api/ai/daily-briefing ──────────────────────────────────────────────

@router.get("/daily-briefing")
def daily_briefing(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Morning briefing. Returns {greeting, summary, priorities[], alerts[], tip}."""
    snapshot = execute_tool("get_business_snapshot", {}, _AGENT)
    followups = _compute_followups(db)
    name = getattr(user, "full_name", None) or "there"

    client = _anthropic_client()
    if client is None:
        # Deterministic fallback so the dashboard still shows something useful.
        return _fallback_briefing(name, snapshot, followups)

    system = (
        "You are the BrightBase assistant writing a short morning briefing for "
        "the owner of a cleaning business. Be warm but concise. Respond with "
        "ONLY a JSON object, no prose, with keys: greeting (string, 1 sentence), "
        "summary (string, 1-2 sentences on today's workload and money), "
        "priorities (array of 2-4 short action strings), alerts (array of 0-3 "
        "urgent strings), tip (string, 1 short suggestion). Base everything on "
        "the data provided — do not invent figures."
    )
    payload = {
        "owner_name": name,
        "today": date.today().isoformat(),
        "snapshot": snapshot,
        "items_needing_attention": followups["followups"],
    }
    try:
        text = _run_tool_loop(client, system, json.dumps(payload, default=str),
                              max_tokens=900, max_iters=2)
        data = json.loads(_strip_json(text))
        return {
            "greeting": data.get("greeting", f"Good morning, {name}."),
            "summary": data.get("summary", ""),
            "priorities": data.get("priorities", []) or [],
            "alerts": data.get("alerts", []) or [],
            "tip": data.get("tip", ""),
        }
    except Exception:
        logger.exception("ai/daily-briefing failed; using fallback")
        return _fallback_briefing(name, snapshot, followups)


def _fallback_briefing(name, snapshot, followups):
    s = snapshot if isinstance(snapshot, dict) else {}
    jobs_today = s.get("jobs_today", 0)
    outstanding = s.get("outstanding_invoices", 0)
    summary = (
        f"You have {jobs_today} job(s) scheduled today and "
        f"{s.get('jobs_this_week', 0)} this week. "
        f"Outstanding invoices total ${outstanding:,.0f}."
    )
    alerts = [f["title"] for f in followups["followups"] if f["severity"] == "high"][:3]
    priorities = [f["action"] for f in followups["followups"]][:4]
    return {
        "greeting": f"Good morning, {name}.",
        "summary": summary,
        "priorities": priorities or ["You're all caught up — nice work."],
        "alerts": alerts,
        "tip": "Press ⌘K anytime to ask the assistant about your business.",
    }


# ── GET /api/ai/followup-check ──────────────────────────────────────────────

@router.get("/followup-check")
def followup_check(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Deterministic scan for things needing attention. {total, followups[]}."""
    return _compute_followups(db)


def _compute_followups(db: Session) -> dict:
    """Build the prioritized list of items needing attention. Pure DB reads;
    each entry has title / detail / action / severity ('high' | 'medium')."""
    today = date.today().isoformat()
    soon = (date.today() + timedelta(days=2)).isoformat()
    items = []

    # Overdue invoices (explicitly overdue, or sent + past due date).
    overdue = db.query(Invoice).filter(
        Invoice.status.in_(["sent", "overdue"])
    ).all()
    overdue = [i for i in overdue if i.status == "overdue"
               or (i.due_date and str(i.due_date) < today)]
    if overdue:
        amt = sum(i.total or 0 for i in overdue)
        items.append({
            "title": f"{len(overdue)} overdue invoice(s)",
            "detail": f"${amt:,.0f} past due across {len(overdue)} invoice(s).",
            "action": "Send payment reminders",
            "severity": "high",
        })

    # Upcoming jobs with no cleaner assigned.
    upcoming = db.query(Job).filter(
        Job.scheduled_date >= today, Job.status == "scheduled"
    ).all()
    unassigned = [j for j in upcoming if not (j.cleaner_ids or [])]
    if unassigned:
        soon_unassigned = [j for j in unassigned if str(j.scheduled_date) <= soon]
        sev = "high" if soon_unassigned else "medium"
        when = " (some within 48h)" if soon_unassigned else ""
        items.append({
            "title": f"{len(unassigned)} unassigned job(s)",
            "detail": f"Upcoming jobs with no cleaner assigned{when}.",
            "action": "Assign cleaners on the schedule",
            "severity": sev,
        })

    # Upcoming jobs not pushed to Google Calendar.
    not_on_gcal = [j for j in upcoming if not j.calendar_invite_sent]
    if not_on_gcal:
        items.append({
            "title": f"{len(not_on_gcal)} job(s) not on Google Calendar",
            "detail": "Scheduled jobs haven't synced to Google Calendar.",
            "action": "Push to Google Calendar",
            "severity": "medium",
        })

    # Active recurring schedules with no upcoming jobs generated.
    empty_recurring = []
    for s in db.query(RecurringSchedule).filter(RecurringSchedule.active == True).all():
        cnt = db.query(Job).filter(
            Job.recurring_schedule_id == s.id, Job.scheduled_date >= today
        ).count()
        if cnt == 0:
            empty_recurring.append(s)
    if empty_recurring:
        items.append({
            "title": f"{len(empty_recurring)} recurring schedule(s) with no upcoming jobs",
            "detail": "Active recurring schedules haven't generated future jobs.",
            "action": "Generate jobs from recurring schedules",
            "severity": "medium",
        })

    # New leads (likely awaiting follow-up).
    leads = db.query(Client).filter(Client.status == "lead").count()
    if leads:
        items.append({
            "title": f"{leads} open lead(s)",
            "detail": "Leads in the pipeline that may need a follow-up.",
            "action": "Review leads and reach out",
            "severity": "medium",
        })

    # High severity first, then medium; preserve insertion order within a tier.
    order = {"high": 0, "medium": 1, "low": 2}
    items.sort(key=lambda f: order.get(f["severity"], 3))
    return {"total": len(items), "followups": items}
