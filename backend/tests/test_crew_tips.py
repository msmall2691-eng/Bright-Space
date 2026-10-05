"""Pro cleaning tips on the crew home rotate daily.

The built-in tip deck rides the my-day payload (data.tips) as a quiet,
always-there way to train the team — text only, no extra fetch
(brightbase-economy). The whole library ships, ordered so TODAY's tip leads and
the crew can flip through the rest on the card.
"""
from datetime import date

import pytest

from modules.crew.router import _daily_tips, _tip_deck, _PRO_TIPS
from database.db import SessionLocal
from database.models import CrewDoc


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


def test_office_tips_replace_the_builtins_when_present():
    """The office writes its own tips (published "tip" CrewDocs); those become
    the deck in its own voice, pinned-first, instead of the built-in library."""
    db = SessionLocal()
    ids = []
    try:
        pairs = [("Text when you arrive", "A quick 'here' keeps the office off your back.", False),
                 ("Blue booties, every house", "No exceptions — tracked-in grit is the #1 complaint.", True)]
        for title, body, pinned in pairs:
            d = CrewDoc(org_id=1, title=title, body=body, category="tip",
                        published=True, owner_user_id=None, pinned=pinned)
            db.add(d); db.commit(); db.refresh(d); ids.append(d.id)

        deck = _tip_deck(db, 1)
        titles = [t["title"] for t in deck]
        # Only the office's tips — the built-in library is replaced, not appended.
        assert titles == ["Blue booties, every house", "Text when you arrive"]  # pinned first
        assert all(bt["title"] not in titles for bt in _PRO_TIPS)
        # Bodies survive so the home card can show the detail.
        assert deck[0]["body"].startswith("No exceptions")
    finally:
        db.query(CrewDoc).filter(CrewDoc.id.in_(ids or [0])).delete(synchronize_session=False)
        db.commit(); db.close()


def test_falls_back_to_builtins_when_office_wrote_none():
    db = SessionLocal()
    try:
        # An org with no "tip" docs gets the built-in library verbatim.
        assert _tip_deck(db, 987654) is _PRO_TIPS
    finally:
        db.close()


def test_a_private_cleaner_note_is_never_served_as_a_tip():
    """A cleaner's private CrewDoc (owner_user_id set) must not leak into the
    company tip deck, even if someone miscategorized it as a tip."""
    db = SessionLocal()
    ids = []
    try:
        d = CrewDoc(org_id=1, title="my gate code reminder", body="side gate 4421",
                    category="tip", published=True, owner_user_id=424242, pinned=False)
        db.add(d); db.commit(); db.refresh(d); ids.append(d.id)
        deck = _tip_deck(db, 1)
        assert all(t["title"] != "my gate code reminder" for t in deck)
        assert deck is _PRO_TIPS   # no company tips → built-ins
    finally:
        db.query(CrewDoc).filter(CrewDoc.id.in_(ids or [0])).delete(synchronize_session=False)
        db.commit(); db.close()
