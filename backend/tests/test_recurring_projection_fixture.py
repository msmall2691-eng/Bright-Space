"""The frontend's copy of the recurring projection must not go stale.

`frontend/src/components/recurring/helpers.js`'s `computeUpcoming` is a
hand-written mirror of `generate_dates`, and for as long as its only test
compared it to its own author's expectations the two drifted: four divergences
by the time anybody ran both sides over the same rules, each one visible to the
owner as a visit the screen promised and nothing created, or the reverse.

The fix was a shared case table (`scripts/recurring_projection_cases.py`) and a
generated fixture of the BACKEND's answers, which
`__tests__/projectionParity.test.js` asserts the mirror reproduces. That makes
the frontend honest about today's rules. This test is the other half, and
without it the whole thing is a snapshot that rots: change `_occurs_on` and the
fixture still holds last month's answers, the frontend test still passes
against them, and nothing anywhere says the mirror is now wrong.

So this fails the moment the backend's projection stops matching the committed
fixture. The remedy is in the failure message: regenerate, then let
`projectionParity.test.js` tell you whether the mirror needs updating too.

Deliberately NOT asserting any particular dates. The expected values live in
the fixture, which is generated rather than typed, because a second hand-written
copy of the answers is precisely the thing that drifted.
"""
import json
import os

import pytest

FIXTURE = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, os.pardir,
    "frontend", "src", "components", "recurring", "__tests__",
    "projection.fixture.json",
))

REGENERATE = "cd backend && python scripts/gen_recurring_projection_fixture.py"


@pytest.fixture(scope="module")
def committed():
    if not os.path.exists(FIXTURE):
        pytest.fail(f"{FIXTURE} is missing — run: {REGENERATE}")
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def test_the_fixture_still_matches_what_generate_dates_produces(committed):
    from scripts.recurring_projection_cases import TODAY, backend_projection

    assert committed["today"] == TODAY.isoformat(), (
        f"the fixture was generated for {committed['today']} but the case table "
        f"now pins {TODAY.isoformat()} — run: {REGENERATE}"
    )

    live = backend_projection()
    stored = {c["name"]: c["dates"] for c in committed["cases"]}

    assert sorted(stored) == sorted(live), (
        "the case table and the fixture disagree about WHICH cases exist "
        f"(only in fixture: {sorted(set(stored) - set(live))}; only in table: "
        f"{sorted(set(live) - set(stored))}) — run: {REGENERATE}"
    )

    drifted = {name: {"fixture": stored[name], "backend": live[name]}
               for name in live if stored[name] != live[name]}
    assert not drifted, (
        "generate_dates no longer produces the dates the frontend parity test "
        f"checks against:\n{json.dumps(drifted, indent=2)}\n\n"
        f"Run: {REGENERATE}\nThen run the frontend suite — "
        "projectionParity.test.js will say whether computeUpcoming needs the "
        "same change."
    )


def test_the_case_table_actually_covers_the_rules_that_diverged(committed):
    """A ratchet on the table itself.

    Every case here was added because it distinguished two readings of a rule,
    and four of them were added because the mirror had got that rule WRONG in
    a way that reached the screen. Dropping one would reopen the hole silently:
    the parity test would still pass, on a smaller table.
    """
    names = {c["name"] for c in committed["cases"]}
    for required in ("monthly_31", "monthly_29", "ends_on_date", "future_start",
                     "short_window", "end_beyond_window", "biweekly_anchored",
                     "biweekly_other_phase", "daily_every_three_days"):
        assert required in names, (
            f"case {required!r} pinned a rule the frontend mirror had wrong; "
            "it must stay covered"
        )
    assert len(names) >= 19, "cases were removed from the table"


def test_every_case_produces_at_least_one_date(committed):
    """A case expanding to nothing asserts nothing.

    Easy to introduce by mistake — a rule whose `days_of_week` and
    `day_of_week` are both unset, or a window that ends before it starts — and
    it would sit in the table looking like coverage. `ends_on_date` and
    `short_window` are the deliberately SHORT cases and still yield three each.
    """
    empty = [c["name"] for c in committed["cases"] if not c["dates"]]
    assert not empty, f"these cases expand to no dates at all: {empty}"
