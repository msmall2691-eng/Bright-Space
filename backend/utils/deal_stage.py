"""Canonical deal vocabulary — the single place the three status languages
that describe a deal's life are defined and reconciled.

A deal in BrightBase is really one thing (an `Opportunity`), but three layers
each spell its state differently, and they drifted apart:

  * `LeadIntake.status`   — the pre-triage inbox: new | reviewed | quoted |
                            archived  (+ two declared-but-dead values,
                            `converted` and `received`, that no code writes)
  * `Opportunity.stage`   — the deal spine: new | qualified | quoted | won | lost
  * `Quote.status`        — draft | sent | viewed | changes_requested |
                            accepted | converted | declined | expired | archived

This module holds the canonical continuum and the maps between the layers so
nothing re-invents them. Per the P4 decision, a lead's *display* status is
DERIVED from the spine (its quote / opportunity) rather than stored a fourth
time — which is what finally lets the inbox show a converted lead as
`converted` (no code ever wrote that value, so the Requests list mislabeled
won deals as still `quoted`).
"""

# The board continuum, inbox → terminal. `inbox` is DERIVED (an un-triaged
# lead with no Opportunity yet); it is never stored on `Opportunity.stage`.
DEAL_STAGES = ["inbox", "new", "qualified", "quoted", "won", "lost"]

# Opportunity.stage forward order; won/lost are terminal (rank highest so a
# deal never regresses out of them). Mirrors utils.opportunity_helper._RANK,
# which imports this so the two can't drift.
STAGE_RANK = {"new": 0, "qualified": 1, "quoted": 2, "won": 3, "lost": 3}

# Quote.status → Opportunity.stage. Used by the one-time backfill and by the
# board read-model to collapse a quote's fine-grained status onto the spine.
QUOTE_STATUS_STAGE = {
    "draft": "quoted", "sent": "quoted", "viewed": "quoted",
    "changes_requested": "quoted", "accepted": "quoted",
    "converted": "won", "declined": "lost", "expired": "lost", "archived": "lost",
}

# The stable vocabulary the Requests inbox renders (frontend Requests.jsx
# STATUS_CONFIG). We keep display within this set so the existing inbox UI
# needs no new states — we just make `converted` finally reachable.
LEAD_DISPLAY_STATUSES = ["new", "reviewed", "quoted", "converted", "archived"]


def lead_display_status_candidate_filter(model, display_status):
    """A SQL prefilter for the derived-status Requests tabs.

    `lead_display_status` is DERIVED (P4) rather than stored, so the intake
    list can't filter the `status` column for new/reviewed/quoted/converted —
    it loaded EVERY non-archived lead, batch-loaded their quotes, derived each
    one, then sliced in Python. On an org with thousands of leads that is a
    full-table scan on every Requests tab load (BB-FIND-03).

    This returns a SQLAlchemy condition that is a guaranteed SUPERSET of the
    rows whose derived display status is `display_status`, so the scan can be
    pruned to candidates while `lead_display_status` still makes the exact call
    in Python — no derivation logic is duplicated into SQL, only a coarse "could
    this row possibly be T" gate. Returns None for a value it can't safely
    prune (an unusual stored status), so the caller falls back to the full scan.

    Two assumptions, both true of the intake list: archived rows are already
    excluded by the caller, and a lead's quote is available only via
    `converted_quote_id` (how the list batch-loads quotes) — so the derivation
    reduces to `converted_quote_id`, `opportunity_id` and the stored `status`.

    Kept HERE, beside lead_display_status, ON PURPOSE: the two must move
    together, and `tests/test_intake_derived_filter.py` asserts the pruned scan
    returns exactly what a full scan + derivation would, on every tab.
    """
    from sqlalchemy import and_, or_

    cq = model.converted_quote_id
    op = model.opportunity_id
    st = model.status
    if display_status in ("converted", "quoted"):
        # Both derive from a lead carrying a converted_quote_id (its quote then
        # splits converted vs quoted) — or, rarely, from the stored status alone
        # on a lead with no quote and no opportunity.
        return or_(cq.isnot(None),
                   and_(cq.is_(None), op.is_(None), st == display_status))
    if display_status == "reviewed":
        # Promoted to a deal but not yet quoted, or stored 'reviewed' with no quote.
        return and_(cq.is_(None), or_(op.isnot(None), st == "reviewed"))
    if display_status == "new":
        # No quote, no opportunity, and a stored status that itself falls through
        # to 'new' (step 5 returns the stored value for the other words).
        return and_(cq.is_(None), op.is_(None),
                    or_(st.is_(None),
                        st.notin_(["reviewed", "quoted", "converted", "archived"])))
    return None  # unknown display value → caller scans everything (unchanged)


def lead_display_status(intake, quote=None):
    """Derive a lead's inbox status from the strongest available signal.

    Precedence (most authoritative first):
      1. `archived` — the one genuinely operator-set state; it always wins,
         because archiving is a deliberate "get this off my screen" action.
      2. `converted` — the lead's quote became a job (`quote.status == "converted"`).
         This is the value no backend code ever stored, so it never showed
         before; derivation is what surfaces it.
      3. `quoted` — a quote exists for the lead (any other quote status), or
         the lead carries a `converted_quote_id`.
      4. `reviewed` — the lead was promoted to a deal (has an opportunity)
         but hasn't been quoted yet.
      5. otherwise the stored `status` (covers manual `reviewed`, plain `new`).

    `quote` is the lead's linked quote object if the caller already loaded it
    (the intake list batch-loads it via `converted_quote_id`); pass None to
    fall back to the FK presence check.
    """
    stored = getattr(intake, "status", None)
    if stored == "archived":
        return "archived"
    quote_status = getattr(quote, "status", None) if quote is not None else None
    if quote_status == "converted":
        return "converted"
    if quote is not None or getattr(intake, "converted_quote_id", None):
        return "quoted"
    if getattr(intake, "opportunity_id", None):
        return "reviewed"
    return stored or "new"
