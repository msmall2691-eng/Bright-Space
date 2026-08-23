"""Autopilot level 2 — the approval queue fills itself.

Level 1 was the app handing work forward between pipeline stages on its own.
This is the next step: instead of the owner FINDING the follow-ups and then
writing each message, a persona drafts them ahead of her and parks them in the
EXISTING ProposedAction queue (services/proposals.py), where she edits a word
and taps Send — or dismisses.

Two producers, both the same shape ("someone is waiting on us and nobody has
replied"):

  waiting_reply — an SMS conversation whose last word was the customer's, with
    no reply since and enough time gone by to be embarrassing.
  quote_nudge  — a quote that was sent and has gone quiet, but hasn't expired.

Both DRAFT through the endpoints that already exist and are already reviewed by
a human today (modules/ai/router: draft_conversation_reply,
_draft_quote_followup) rather than growing a second prompt for the same job,
and both propose the `send_sms` kind, which already executes through the real
outbound comms path. Nothing here sends anything.

WHY THERE IS NO NEW TICK (skills/brightbase-economy rule 1, scheduling
invariants R1): drafting runs when the owner opens Home for the first time on
a business day, and only then — one burst, on a day she is actually in the
app, capped at `_MAX_PER_RUN` drafts. A tick would spend money every morning
whether or not anyone looked. Settings → Automation has the off switch and a
"draft now" button for a manual run.

COST SHAPE: one cheap (haiku-tier) completion per draft, at most
`_MAX_PER_RUN` per run, and a source is not re-drafted for `_COOLDOWN_HOURS`
after the last time it was proposed — so a queue she hasn't cleared doesn't
re-draft itself every morning, and one she dismissed doesn't come straight
back.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import Client, Conversation, ProposedAction, Quote
from services.proposals import create_proposal

logger = logging.getLogger(__name__)

AGENT_ID = "scout"          # Sales & Growth — leads, quotes, chasing replies

# How long a customer may sit unanswered before a draft is worth writing. Short
# enough to matter (a lead answered the same morning converts; one answered
# tomorrow often doesn't), long enough that it never races the owner replying
# herself over her coffee.
_WAITING_AFTER_HOURS = 4

# A sent quote goes quiet for this long before it's worth a nudge. Under three
# days a nudge reads as pushy; past ~two weeks the auto-expiry sweep has
# usually taken it anyway.
_QUOTE_QUIET_DAYS = 3

# Ceiling per run. Six is about what an owner will actually work through in one
# sitting; drafting thirty would cost thirty completions to produce a wall.
_MAX_PER_RUN = 6

# Don't re-draft the same source this soon after the last proposal for it —
# whatever she did with that one (approved, dismissed, ignored).
_COOLDOWN_HOURS = 20

# Only conversations on a channel `send_sms` can actually execute on. An email
# thread would draft fine and then have no approved path to send through, so it
# is skipped and counted rather than queued as an un-approvable row.
_EXECUTABLE_CHANNELS = ("sms",)


def _naive_utc(dt):
    """Compare-safe UTC. These columns are naive `DateTime`, but the code
    writing them passes aware `datetime.now(timezone.utc)` values, so what
    comes back is naive on one backend and aware on another. Subtracting the
    two shapes raises, which in a once-a-day drafting run would look like the
    feature silently not working."""
    if dt is None:
        return None
    return dt.replace(tzinfo=None) if dt.tzinfo is None else \
        dt.astimezone(timezone.utc).replace(tzinfo=None)


def _org(model, org_id: int):
    """Standard NULL-tolerant tenant filter (MT-3): pre-tenancy rows have a
    NULL org_id and belong to the founding org."""
    return or_(model.org_id == org_id, model.org_id.is_(None))


def _recent_sources(db: Session, org_id: int, now: datetime) -> set[str]:
    """Sources already spoken for: every `send_sms` proposal that is still
    pending, plus any decided inside the cooldown. Keyed on the payload's
    `source` — `create_proposal`'s own dedupe compares whole payloads, and two
    drafts of the same reply are never byte-identical, so it can't see these."""
    cutoff = _naive_utc(now) - timedelta(hours=_COOLDOWN_HOURS)
    seen = set()
    for row in db.query(ProposedAction).filter(
        ProposedAction.org_id == org_id,
        ProposedAction.kind == "send_sms",
    ).order_by(ProposedAction.id.desc()).limit(200).all():
        source = (row.payload or {}).get("source")
        if not source:
            continue
        if row.status == "pending":
            seen.add(source)
            continue
        decided = _naive_utc(row.decided_at) or _naive_utc(row.created_at)
        if decided and decided >= cutoff:
            seen.add(source)
    return seen


def _client_label(client, fallback: str) -> str:
    if client is None:
        return fallback
    return (client.name or "").strip() or fallback


def _hours_ago(then: datetime, now: datetime) -> int:
    delta = _naive_utc(now) - _naive_utc(then)
    return max(0, int(delta.total_seconds() // 3600))


def _waiting_conversations(db: Session, org_id: int, now: datetime) -> list:
    """Open SMS threads where the customer spoke last and nobody answered.

    The `last_inbound_at` / `last_outbound_at` aggregates that comms keeps on
    every conversation (`_apply_inbound` / `_apply_outbound`) answer this in
    one indexed query — no walking messages, no per-row lookups. The age check
    happens in Python so a naive/aware mismatch can't turn into a WHERE clause
    that quietly matches nothing."""
    rows = (db.query(Conversation)
            .filter(Conversation.channel.in_(_EXECUTABLE_CHANNELS),
                    Conversation.status.in_(("open", "pending")),
                    Conversation.last_inbound_at.isnot(None),
                    or_(Conversation.last_outbound_at.is_(None),
                        Conversation.last_outbound_at < Conversation.last_inbound_at),
                    _org(Conversation, org_id))
            .order_by(Conversation.last_inbound_at.asc())
            .limit(50).all())

    out = []
    for conv in rows:
        snoozed = _naive_utc(conv.snoozed_until)
        if snoozed and snoozed > _naive_utc(now):
            continue                       # deliberately parked by a human
        if _hours_ago(conv.last_inbound_at, now) < _WAITING_AFTER_HOURS:
            continue
        out.append(conv)
    return out


def _quiet_quotes(db: Session, org_id: int, now: datetime) -> list:
    """Quotes the customer was shown and hasn't answered. Only sent/viewed
    qualify, matching draft_quote_followup's own rule: a draft was never seen,
    and an accepted or declined one already got its answer."""
    cutoff = _naive_utc(now) - timedelta(days=_QUOTE_QUIET_DAYS)
    rows = (db.query(Quote)
            .filter(Quote.status.in_(("sent", "viewed")), _org(Quote, org_id))
            .order_by(Quote.sent_at.asc())
            .limit(50).all())
    return [q for q in rows
            if (_naive_utc(q.sent_at) or _naive_utc(q.created_at))
            and (_naive_utc(q.sent_at) or _naive_utc(q.created_at)) <= cutoff]


def _draft_waiting_reply(db: Session, conv) -> str:
    """The drafted text, via the SAME endpoint the Comms "Draft with AI" button
    calls. Called as a plain function with explicit args — the repo pattern for
    reusing a router's logic (see services/proposals.py) — so there is one
    prompt for "reply to this conversation", not two that drift apart."""
    from modules.ai import router as ai_router

    drafted = ai_router.draft_conversation_reply(
        conv.id, ai_router.DraftLeadRequest(), db=db, user=None)
    return ((drafted or {}).get("message") or "").strip()


def _draft_quote_nudge(db: Session, org_id: int, quote) -> str:
    from modules.ai import router as ai_router

    drafted = ai_router.draft_quote_followup(
        quote.id, ai_router.DraftNudgeRequest(channel="sms"),
        db=db, org_id=org_id)
    return ((drafted or {}).get("message") or "").strip()


def draft_followups(db: Session, org_id: int, *, limit: int = _MAX_PER_RUN) -> dict:
    """Draft the day's follow-ups and park them as pending proposals.

    Returns {proposed: [ids], skipped: {reason: n}, checked: n}. Never raises
    for a single bad row: one conversation that can't be drafted must not cost
    the owner the other five."""
    from modules.ai.router import _anthropic_client

    limit = max(1, min(int(limit or _MAX_PER_RUN), _MAX_PER_RUN))
    skipped: dict[str, int] = {}

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    # Without a model the drafters fall back to a generic "thanks, we're on
    # it" template. That's a reasonable holding reply when the model is merely
    # having a bad minute, but filling an approval queue with six identical
    # form letters is not what this feature is for.
    if _anthropic_client() is None:
        return {"proposed": [], "skipped": {"no_model": 1}, "checked": 0,
                "reason": "no_model"}

    now = datetime.now(timezone.utc)
    spoken_for = _recent_sources(db, org_id, now)
    proposed: list[int] = []
    checked = 0

    for conv in _waiting_conversations(db, org_id, now):
        if len(proposed) >= limit:
            skip("over_limit")
            continue
        checked += 1
        source = f"waiting_reply:{conv.id}"
        if source in spoken_for:
            skip("already_proposed")
            continue
        client = (db.query(Client).filter(Client.id == conv.client_id,
                                          _org(Client, org_id)).first()
                  if conv.client_id else None)
        who = _client_label(client, conv.external_contact or "this customer")
        try:
            body = _draft_waiting_reply(db, conv)
        except Exception:
            logger.exception("[autopilot-drafts] reply draft failed for conversation %s",
                             conv.id)
            skip("draft_failed")
            continue
        if not body:
            skip("draft_empty")
            continue
        waited = _hours_ago(conv.last_inbound_at, now)
        row = create_proposal(
            db, org_id=org_id, agent_id=AGENT_ID, kind="send_sms",
            title=f"Reply to {who} — waiting {waited}h",
            detail=(f"{who} texted {waited} hours ago and hasn't had an answer. "
                    "Edit the draft if you want, then send it — or dismiss and "
                    "it won't come back today."),
            payload={"conversation_id": conv.id, "body": body, "source": source},
        )
        proposed.append(row.id)

    for quote in _quiet_quotes(db, org_id, now):
        if len(proposed) >= limit:
            skip("over_limit")
            continue
        checked += 1
        source = f"quote_nudge:{quote.id}"
        if source in spoken_for:
            skip("already_proposed")
            continue
        client = db.query(Client).filter(Client.id == quote.client_id,
                                         _org(Client, org_id)).first()
        # `send_sms` with a client_id resolves the number off the Client row,
        # so no phone means no executable proposal — queueing it anyway would
        # only produce a row that fails on approval.
        if not client or not (client.phone or "").strip():
            skip("no_phone")
            continue
        try:
            body = _draft_quote_nudge(db, org_id, quote)
        except Exception:
            logger.exception("[autopilot-drafts] quote nudge draft failed for quote %s",
                             quote.id)
            skip("draft_failed")
            continue
        if not body:
            skip("draft_empty")
            continue
        quiet_for = _hours_ago(quote.sent_at or quote.created_at, now) // 24
        row = create_proposal(
            db, org_id=org_id, agent_id=AGENT_ID, kind="send_sms",
            title=f"Nudge {_client_label(client, 'the customer')} about "
                  f"{quote.title or quote.quote_number}",
            detail=(f"Quote {quote.quote_number} has been out {quiet_for} day(s) "
                    "with no answer. Edit the draft if you want, then send it."),
            payload={"client_id": client.id, "body": body, "source": source},
        )
        proposed.append(row.id)

    logger.info("[autopilot-drafts] org=%s proposed=%s skipped=%s",
                org_id, len(proposed), skipped)
    return {"proposed": proposed, "skipped": skipped, "checked": checked}
