"""Canonical deal vocabulary + derived lead status (P4 PR-1).

The crux these pin: a lead's inbox status is DERIVED from its quote/opportunity,
not stored — which is what finally surfaces `converted` (no code ever wrote it,
so a won lead used to read as still `quoted`). Plain-object stand-ins keep this
a pure unit test with no DB.
"""
from types import SimpleNamespace

from utils.deal_stage import (
    DEAL_STAGES, STAGE_RANK, QUOTE_STATUS_STAGE, lead_display_status,
)


def _intake(**kw):
    kw.setdefault("status", "new")
    kw.setdefault("converted_quote_id", None)
    kw.setdefault("opportunity_id", None)
    return SimpleNamespace(**kw)


def test_canonical_maps_are_coherent():
    assert DEAL_STAGES == ["inbox", "new", "qualified", "quoted", "won", "lost"]
    # won and lost are terminal — same top rank so a deal never regresses out.
    assert STAGE_RANK["won"] == STAGE_RANK["lost"] == max(STAGE_RANK.values())
    # Every quote status maps onto a real opportunity stage.
    assert set(QUOTE_STATUS_STAGE.values()) <= set(DEAL_STAGES)


def test_shared_map_is_the_same_object_opportunity_helper_uses():
    # opportunity_helper must import (not re-declare) these, or the two drift.
    import utils.opportunity_helper as oh
    assert oh._QUOTE_STATUS_STAGE is QUOTE_STATUS_STAGE
    assert oh._RANK is STAGE_RANK


def test_archived_always_wins():
    intake = _intake(status="archived", converted_quote_id=99, opportunity_id=5)
    quote = SimpleNamespace(status="converted")
    assert lead_display_status(intake, quote) == "archived"


def test_converted_is_derived_from_the_quote():
    # The bug this fixes: nothing stores "converted" on the lead, so a won lead
    # read as "quoted". Deriving from quote.status surfaces it.
    intake = _intake(status="quoted", converted_quote_id=99)
    quote = SimpleNamespace(status="converted")
    assert lead_display_status(intake, quote) == "converted"


def test_quoted_when_a_quote_exists_in_any_other_status():
    intake = _intake(status="new", converted_quote_id=12)
    for qs in ("draft", "sent", "viewed", "declined", "expired"):
        assert lead_display_status(intake, SimpleNamespace(status=qs)) == "quoted"


def test_quoted_from_fk_even_without_the_loaded_quote_object():
    intake = _intake(status="new", converted_quote_id=7)
    assert lead_display_status(intake, None) == "quoted"


def test_reviewed_when_promoted_to_a_deal_but_not_quoted():
    intake = _intake(status="new", opportunity_id=3)
    assert lead_display_status(intake, None) == "reviewed"


def test_falls_back_to_stored_status_for_plain_leads():
    assert lead_display_status(_intake(status="new"), None) == "new"
    assert lead_display_status(_intake(status="reviewed"), None) == "reviewed"
    # Missing/empty stored status defaults to new, never blank.
    assert lead_display_status(_intake(status=None), None) == "new"


def test_derived_status_stays_in_the_inbox_vocabulary():
    from utils.deal_stage import LEAD_DISPLAY_STATUSES
    samples = [
        (_intake(status="archived"), None),
        (_intake(status="quoted", converted_quote_id=1), SimpleNamespace(status="converted")),
        (_intake(status="new", converted_quote_id=1), SimpleNamespace(status="sent")),
        (_intake(status="new", opportunity_id=1), None),
        (_intake(status="new"), None),
    ]
    for intake, quote in samples:
        assert lead_display_status(intake, quote) in LEAD_DISPLAY_STATUSES
