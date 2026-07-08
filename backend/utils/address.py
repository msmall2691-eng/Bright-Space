"""Address string helpers.

`combine_address` is the Python twin of `frontend/src/utils/format.js#combineAddress`.
It appends optional city / state / zip components to a base address string,
but SKIPS any component that already appears as a token in the base — so a
LeadIntake row whose `address` field already reads "Keystone Drive, Waterboro,
ME, 04061" (the maineclean.co /book flow assembles the full string before
POSTing) does not get ", ME" appended a second time. See the July-2026 audit
findings L1/L3 for the customer-visible symptom this prevents.
"""

from typing import Optional


def format_address(addr: Optional[str]) -> str:
    """Canonical RENDER-side formatter: collapse duplicate comma components in an
    already-assembled address string, preserving order of first appearance.

    `combine_address` prevents the doubling at WRITE time, but rows saved before
    that fix (e.g. QT-2026-0034 "100 Congress Street, Portland, ME, 04101, ME")
    still carry the repeated state token. This normalizes them on the way out so
    the email, PDF, public page, and admin all render one clean line. Matching is
    case-insensitive; the first spelling/casing seen is the one kept.

        format_address("100 Congress Street, Portland, ME, 04101, ME")
            -> "100 Congress Street, Portland, ME, 04101"
    """
    if not addr or not str(addr).strip():
        return ""
    seen = set()
    parts = []
    for raw in str(addr).split(","):
        tok = raw.strip()
        if not tok:
            continue
        key = tok.lower()
        if key in seen:
            continue
        seen.add(key)
        parts.append(tok)
    return ", ".join(parts)


def combine_address(
    base: Optional[str],
    city: Optional[str] = None,
    state: Optional[str] = None,
    zip_code: Optional[str] = None,
) -> str:
    """Return "base[, city][, state][, zip]" with each optional component
    skipped when it already appears (case-insensitively) as a comma/whitespace
    token in `base`. Preserves order of remaining components.

    Examples:
        combine_address("155 Main St, Portland, ME, 04101", None, "ME", None)
            -> "155 Main St, Portland, ME, 04101"
        combine_address("155 Main St", "Portland", "ME", "04101")
            -> "155 Main St, Portland, ME, 04101"
    """
    parts = []
    if base and base.strip():
        parts.append(base.strip())
    # Split on COMMAS only, not every whitespace: an address like
    # "12 Portland St" is one component ("12 Portland St"), not three tokens
    # ("12", "Portland", "St"). Whitespace-splitting silently dropped
    # "Portland" as the city argument when the street name happened to
    # contain the city's word — cf. the codex P2 on PR #527.
    tokens = {
        t.strip().lower()
        for t in (base or "").split(",")
        if t.strip()
    }

    for extra in (city, state, zip_code):
        if not extra:
            continue
        s = str(extra).strip()
        if not s:
            continue
        if s.lower() in tokens:
            continue
        parts.append(s)
        tokens.add(s.lower())

    return ", ".join(parts)
