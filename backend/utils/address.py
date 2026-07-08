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
    import re

    parts = []
    if base and base.strip():
        parts.append(base.strip())
    # Build the token set from base so we can suppress any duplicate append.
    tokens = {
        t.lower()
        for t in re.split(r"[,\s]+", base or "")
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
