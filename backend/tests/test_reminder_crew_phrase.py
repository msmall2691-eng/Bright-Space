"""BB-CUST-02: the 24h reminder credits everyone coming, not just a solo cleaner.

_crew_phrase folds the crew into the one reminder sentence: up to three names in
full, then "and N more" so a large changeover can't blow the text into several
billed segments. The confirm link carries the whole list with faces either way.
"""
from services.reminder_service import _crew_phrase


def test_nobody_assigned_adds_nothing():
    assert _crew_phrase(None) == ""
    assert _crew_phrase([]) == ""
    assert _crew_phrase(["", None]) == ""     # blanks are not names


def test_one_name():
    assert _crew_phrase(["Amy S."]) == " with Amy S."


def test_two_names_joined_with_and():
    assert _crew_phrase(["Amy S.", "Ben T."]) == " with Amy S. and Ben T."


def test_three_names_all_listed():
    assert _crew_phrase(["Amy S.", "Ben T.", "Cy R."]) == " with Amy S., Ben T. and Cy R."


def test_four_or_more_caps_at_three_then_summarises():
    assert _crew_phrase(["Amy S.", "Ben T.", "Cy R.", "Dee M."]) == \
        " with Amy S., Ben T., Cy R. and 1 more"
    assert _crew_phrase(["A", "B", "C", "D", "E"]) == " with A, B, C and 2 more"
