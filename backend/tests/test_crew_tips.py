"""Pro cleaning tips on the crew home rotate daily.

Two built-in tips ride the my-day payload (data.tips) as a quiet, always-there
way to train the team — text only, no extra fetch (brightbase-economy).
"""
from datetime import date
from modules.crew.router import _daily_tips, _PRO_TIPS


def test_returns_two_well_formed_tips():
    tips = _daily_tips(date(2026, 9, 19))
    assert len(tips) == 2
    for t in tips:
        assert t["title"] and t["body"]


def test_rotates_by_day_but_is_stable_within_a_day():
    d = date(2026, 9, 19)
    assert _daily_tips(d) == _daily_tips(d)          # stable within a day
    assert _daily_tips(d) != _daily_tips(date(2026, 9, 20))  # changes daily


def test_the_two_tips_are_distinct():
    tips = _daily_tips(date(2026, 9, 19))
    assert tips[0]["title"] != tips[1]["title"]


def test_library_is_non_trivial():
    assert len(_PRO_TIPS) >= 8
