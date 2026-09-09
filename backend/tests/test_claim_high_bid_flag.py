"""BB-CLAIM-02: a request well over the posted price is flagged for the office.

A sub can ask for more than the office posted, and the office always decides —
nobody is paid over the posted price without an approval. This only MARKS the
pushy asks so they're obvious at a glance; it never blocks or ranks. The line
is a percentage the owner sets (Settings → Rules), default 20%.
"""
from modules.scheduling.router import _is_high_bid
from database.db import SessionLocal
from services.standing_rules import claim_high_bid_flag_pct, list_rules
from modules.settings.router import set_setting
from database.models import AppSetting


# ── the pure threshold ───────────────────────────────────────────────────────

def test_a_bid_over_the_line_is_flagged():
    assert _is_high_bid(100, 80, 20) is True        # 25% over, line 20%


def test_a_bid_under_the_line_is_not_flagged():
    assert _is_high_bid(95, 80, 20) is False         # 18.75% over, under 20%


def test_a_bid_exactly_at_posted_is_never_flagged():
    assert _is_high_bid(80, 80, 20) is False
    assert _is_high_bid(80, 80, 0) is False          # even with a zero line


def test_a_bid_below_posted_is_never_flagged():
    assert _is_high_bid(70, 80, 20) is False


def test_taking_the_posted_rate_is_never_flagged():
    assert _is_high_bid(None, 80, 20) is False       # requested_rate omitted


def test_an_unpriced_job_has_no_line_to_be_over():
    assert _is_high_bid(200, None, 20) is False
    assert _is_high_bid(200, 0, 20) is False


def test_a_zero_line_flags_anything_over_posted():
    assert _is_high_bid(81, 80, 0) is True
    assert _is_high_bid(80.01, 80, 0) is True


def test_the_line_is_respected():
    # 50% over: flagged at a 20% line, not at a 60% line.
    assert _is_high_bid(120, 80, 20) is True
    assert _is_high_bid(120, 80, 60) is False


# ── the standing rule ────────────────────────────────────────────────────────

def test_the_rule_is_listed_and_defaults_to_20():
    db = SessionLocal()
    try:
        rules = {r["key"]: r for r in list_rules(db)["rules"]}
        assert "claim_high_bid" in rules
        field = rules["claim_high_bid"]["fields"][0]
        assert field["key"] == "claim_high_bid_flag_pct"
        assert field["default"] == 20
        assert claim_high_bid_flag_pct(db) == 20      # unset → default
    finally:
        db.close()


def test_the_office_can_move_the_line():
    db = SessionLocal()
    try:
        set_setting(db, "claim_high_bid_flag_pct", "35"); db.commit()
        assert claim_high_bid_flag_pct(db) == 35
        assert _is_high_bid(105, 80, claim_high_bid_flag_pct(db)) is False   # 31% over, under 35
        assert _is_high_bid(120, 80, claim_high_bid_flag_pct(db)) is True    # 50% over
    finally:
        db.query(AppSetting).filter(AppSetting.key == "claim_high_bid_flag_pct")\
            .delete(synchronize_session=False)
        db.commit(); db.close()
