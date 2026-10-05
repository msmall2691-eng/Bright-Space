"""Pro cleaning tips on the crew home rotate daily.

The built-in tip deck rides the my-day payload (data.tips) as a quiet,
always-there way to train the team — text only, no extra fetch
(brightbase-economy). The whole library ships, ordered so TODAY's tip leads and
the crew can flip through the rest on the card.
"""
from datetime import date
from modules.crew.router import _daily_tips, _PRO_TIPS


def test_returns_the_whole_deck_well_formed():
    tips = _daily_tips(date(2026, 9, 19))
    # The full library ships (today first), not just one or two.
    assert len(tips) == len(_PRO_TIPS)
    for t in tips:
        assert t["title"] and t["body"]


def test_leads_with_todays_tip_and_rotates_by_day():
    d = date(2026, 9, 19)
    assert _daily_tips(d) == _daily_tips(d)                   # stable within a day
    # A different day leads with a different tip (the deck is rotated).
    assert _daily_tips(d)[0] != _daily_tips(date(2026, 9, 20))[0]


def test_deck_is_a_rotation_no_tip_lost_or_duplicated():
    tips = _daily_tips(date(2026, 9, 19))
    titles = [t["title"] for t in tips]
    assert len(set(titles)) == len(_PRO_TIPS)                 # every tip, exactly once


def test_library_is_non_trivial():
    assert len(_PRO_TIPS) >= 8
