"""The typed due_date_d mirror stays in lockstep with the string due_date.

Expand phase of the due_date text→Date conversion: every writer dual-writes for
free via the @validates on Invoice. These pin that the mirror tracks the string,
handles a timestamp-y value, and clears (rather than raising) on blank/garbage —
so a bad string can never break an invoice write.
"""
from datetime import date

from database.models import Invoice


def test_mirror_is_set_from_a_plain_date_string():
    inv = Invoice(due_date="2026-03-15")
    assert inv.due_date_d == date(2026, 3, 15)


def test_mirror_tracks_a_reassignment_and_trims_a_timestamp():
    inv = Invoice(due_date="2026-03-15")
    inv.due_date = "2026-04-01T00:00:00"      # only the date part is taken
    assert inv.due_date_d == date(2026, 4, 1)


def test_blank_or_garbage_clears_the_mirror_without_raising():
    inv = Invoice(due_date="2026-03-15")
    inv.due_date = ""
    assert inv.due_date_d is None
    inv.due_date = "whenever"                 # unparseable → None, no exception
    assert inv.due_date_d is None
    assert inv.due_date == "whenever"          # the string is left untouched


def test_none_is_fine():
    inv = Invoice(due_date=None)
    assert inv.due_date_d is None
