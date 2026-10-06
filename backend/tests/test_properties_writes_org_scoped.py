"""MT-2 — every per-property WRITE on the properties router scopes to the org.

Nine writes on `modules/properties/router.py` took a `property_id` straight
from the path and acted on it without ever asking whose property it was. Four
of their neighbours did (`_property_or_404` has existed the whole time), which
is what makes this an oversight rather than a design.

## How exposed it actually was, stated honestly

Not very, and the reason matters for judging the fix. `Org`'s own docstring
says v1 is single-org — "id=1, seeded at boot" — so there is one tenant today
and nothing to cross. And `current_org_id` arms the MT-3 Postgres session var,
with `properties` and `property_icals` both in `TENANT_TABLES`, so RLS would
have refused a cross-org write in production anyway.

The gap was real in exactly one place: **SQLite, where RLS is a no-op.** That
is the test suite. `test_normalize_properties.py` had a case that POSTed a feed
onto an org-77 property while authenticated as the master API key — which
`current_org_id` documents as operating in the primary org — and it passed. A
test asserting behaviour production does not have is worse than no test, and
that is what an unscoped write bought.

## Why a guard test and not just the six fixes

Because the next route added to this file will be written the same way. The
four that were already scoped did not stop the nine that were not.

The three sweeps are exempt WITH a reason each, and one of them is a question
rather than a decision — see SWEEPS below.
"""
import re
from pathlib import Path

ROUTER = Path(__file__).resolve().parent.parent / "modules" / "properties" / "router.py"
SRC = ROUTER.read_text()

WRITE_METHODS = ("post", "put", "patch", "delete")

# Routes that act across every property by design, so there is no single
# property to scope. Each needs a reason, and these are not equivalent:
#
#   /sync-all and /turnover-sweep are operator-wide maintenance runs. In a
#   single-org install that is the whole install. In a two-org one they would
#   sweep BOTH companies, and the Org docstring is explicit that a second
#   company is meant to be "a data backfill, not a redesign" — so this is a
#   real question for whoever adds the second org, not something to guess at
#   now. Flagged rather than changed.
#
#   /admin/normalize-properties is an admin data utility and cross-org by
#   intent.
SWEEPS = {
    "/sync-all": "operator-wide maintenance run; cross-org behaviour is an open question for a second org",
    "/turnover-sweep": "same shape as /sync-all, same open question",
    "/admin/normalize-properties": "admin data utility, cross-org by intent",
}


def _routes():
    """(method, path, handler source) for every route in the router."""
    hits = [(m.start(), m.group(1), m.group(2))
            for m in re.finditer(r'@router\.(\w+)\("([^"]*)"', SRC)]
    for i, (pos, method, path) in enumerate(hits):
        end = hits[i + 1][0] if i + 1 < len(hits) else len(SRC)
        yield method, path, SRC[pos:end]


def test_every_per_property_write_is_org_scoped():
    offenders = []
    checked = 0
    for method, path, body in _routes():
        if method not in WRITE_METHODS:
            continue
        if path in SWEEPS:
            continue
        if "{property_id}" not in path:
            continue
        checked += 1
        # Either the shared helper (which also calls resolve_org_id) or an
        # explicit org filter. The helper is strongly preferred — a hand-rolled
        # filter skips the resolve step.
        scoped = (
            "_property_or_404(db, property_id, org_id)" in body
            or "Property.org_id == org_id" in body
        )
        has_dep = "org_id: int = Depends(current_org_id)" in body
        if not (scoped and has_dep):
            offenders.append(
                f"{method.upper()} {path}: "
                f"{'no org filter' if not scoped else ''}"
                f"{' and ' if not scoped and not has_dep else ''}"
                f"{'no current_org_id dependency' if not has_dep else ''}".strip()
            )

    assert checked >= 6, f"only {checked} per-property writes found — has the router moved?"
    assert not offenders, (
        "A write that takes a property_id from the path must prove the caller "
        "owns it. Use _property_or_404(db, property_id, org_id):\n  "
        + "\n  ".join(offenders)
    )


def test_the_sweep_exemptions_still_exist():
    """An exemption for a route that was renamed or removed is a blind spot
    that opens quietly, which is how the original nine accumulated."""
    paths = {path for _, path, _ in _routes()}
    missing = [p for p in SWEEPS if p not in paths]
    assert not missing, f"exempt routes no longer exist — drop them from SWEEPS: {missing}"
    for path, reason in SWEEPS.items():
        assert len(reason) > 20, f"{path}: exemption has no real reason"


def test_the_shared_helper_resolves_the_org_rather_than_trusting_it():
    """`_property_or_404` is preferred over a hand-rolled filter specifically
    because it calls `resolve_org_id` first. An endpoint called IN-PROCESS (the
    repo does this — quoting calls create_job directly) receives the
    unresolved `Depends` sentinel rather than an int, and filtering on that
    object silently matches nothing. The helper is the only place that is
    handled, so the preference is load-bearing, not style."""
    helper = SRC[SRC.index("def _property_or_404("):]
    helper = helper[: helper.index("\n\n\n")]
    assert "resolve_org_id(org_id, db)" in helper, (
        "_property_or_404 no longer resolves the org id — an in-process caller "
        "passing the Depends sentinel would filter on it and match nothing"
    )
    assert "Property.org_id.is_(None)" in helper, (
        "_property_or_404 dropped the NULL-org clause, which pre-tenancy rows "
        "still rely on"
    )
