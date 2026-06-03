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


# ── POST /api/ai/draft-invoice-reminder/{invoice_id} ────────────────────────

def _days_overdue(inv: Invoice) -> Optional[int]:
    if not inv.due_date or inv.status == "paid":
        return None
    try:
        due = date.fromisoformat(str(inv.due_date)[:10])
    except (ValueError, TypeError):
        return None
    d = (date.today() - due).days
    return d if d > 0 else None


@router.post("/draft-invoice-reminder/{invoice_id}")
def draft_invoice_reminder(invoice_id: int, db: Session = Depends(get_db),
                           user=Depends(get_current_user)):
    """Draft a friendly payment-reminder note for one invoice. Review-first:
    this only writes a draft, it does not send anything. Returns
    {subject, message}. The message is meant to drop into the invoice send
    panel's note field, so it works for email or SMS."""
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        return {"subject": "", "message": "", "error": "Invoice not found"}
    client = db.query(Client).filter(Client.id == inv.client_id).first()
    return _draft_one(inv, client, _anthropic_client())


def _client_first_name(client) -> str:
    if client and client.name:
        return client.name.split()[0]
    return "there"


def _draft_one(inv: Invoice, client, client_ai) -> dict:
    """Draft a reminder for a single invoice. Uses the LLM when available,
    otherwise a deterministic personalized fallback. Returns {subject, message}.
    Shared by the single-invoice endpoint and the batch chaser."""
    name = _client_first_name(client)
    od = _days_overdue(inv)
    if client_ai is None:
        return _fallback_reminder(name, inv, od)

    amount = inv.total or 0
    facts = {
        "client_first_name": name,
        "invoice_number": inv.invoice_number,
        "amount_due": f"${amount:,.2f}",
        "due_date": str(inv.due_date) if inv.due_date else None,
        "days_overdue": od,
        "status": inv.status,
    }
    tone = ("firm but polite (the invoice is past due)" if od
            else "warm and light (a gentle nudge, not yet overdue)")
    system = (
        "You write short, professional payment-reminder messages for a cleaning "
        "business (Maine Cleaning Co). Tone: " + tone + ". 2-4 sentences, no "
        "subject line in the body, address the client by first name, state the "
        "invoice number and amount, and give a clear, friendly call to pay. "
        "Respond with ONLY a JSON object: {\"subject\": string, \"message\": string}."
    )
    try:
        text = _run_tool_loop(client_ai, system, json.dumps(facts, default=str),
                              max_tokens=400, max_iters=1)
        data = json.loads(_strip_json(text))
        msg = (data.get("message") or "").strip()
        if not msg:
            return _fallback_reminder(name, inv, od)
        return {
            "subject": (data.get("subject") or f"Reminder: invoice {inv.invoice_number}").strip(),
            "message": msg,
        }
    except Exception:
        logger.exception("ai draft failed; using fallback")
        return _fallback_reminder(name, inv, od)


def _fallback_reminder(name, inv: Invoice, od: Optional[int]) -> dict:
    amount = f"${(inv.total or 0):,.2f}"
    if od:
        body = (f"Hi {name}, just a friendly reminder that invoice "
                f"{inv.invoice_number} for {amount} is now {od} day(s) past due. "
                f"When you have a moment, please send payment at your earliest "
                f"convenience — and let us know if you have any questions. Thank you!")
    else:
        body = (f"Hi {name}, a quick reminder about invoice {inv.invoice_number} "
                f"for {amount}"
                + (f", due {inv.due_date}" if inv.due_date else "")
                + ". Thanks so much for your business!")
    return {"subject": f"Reminder: invoice {inv.invoice_number}", "message": body}


# ── GET /api/ai/overdue-reminders ───────────────────────────────────────────

# Bound the batch so a huge AR backlog can't blow up latency/cost with one call.
_BATCH_LIMIT = 20


@router.get("/overdue-reminders")
def overdue_reminders(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Batch chaser: draft a reminder for every overdue invoice at once.
    Review-first — returns drafts only, sends nothing. Each item carries the
    data the UI needs to review and then send via the existing invoice send
    endpoint. {total, truncated, reminders:[...]}."""
    today = date.today().isoformat()
    candidates = db.query(Invoice).filter(
        Invoice.status.in_(["sent", "overdue"])
    ).all()
    overdue = [i for i in candidates
               if i.status == "overdue" or (i.due_date and str(i.due_date) < today)]
    # Oldest first — chase the most delinquent before the rest.
    overdue.sort(key=lambda i: (_days_overdue(i) or 0), reverse=True)
    truncated = len(overdue) > _BATCH_LIMIT
    overdue = overdue[:_BATCH_LIMIT]

    client_ai = _anthropic_client()
    client_map = {c.id: c for c in db.query(Client).all()}
    reminders = []
    for inv in overdue:
        client = client_map.get(inv.client_id)
        draft = _draft_one(inv, client, client_ai)
        reminders.append({
            "invoice_id": inv.id,
            "invoice_number": inv.invoice_number,
            "client_name": (client.name if client else f"Client #{inv.client_id}"),
            "client_email": (client.email if client else None),
            "client_phone": (client.phone if client else None),
            "amount": inv.total or 0,
            "days_overdue": _days_overdue(inv),
            "subject": draft["subject"],
            "message": draft["message"],
        })
    return {"total": len(reminders), "truncated": truncated, "reminders": reminders}


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
