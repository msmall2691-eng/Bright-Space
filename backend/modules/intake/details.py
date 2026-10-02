"""Carry a request's on-site details onto the durable records the crew reads.

The public /book flow captures six "on-site essentials" — entry method, parking
notes, pets detail, focus areas, special instructions, arrival window — but they
land only in ``LeadIntake.custom_fields`` (a JSON blob). Historically no
conversion step copied them onto the Property or the Job, so the crew never saw
them unless an operator retyped them.

These helpers close that gap. The split (decided with the owner):

* **Place-stable** details — how you get in, where to park, what pets live there
  — belong on the **Property**, so they persist for every future visit. Filled
  ONLY where the property field is still empty, so an operator's own edit is
  never overwritten.
* **Per-visit** details — what to focus on, special instructions, the arrival
  window — belong on the **Job**, appended to its notes (which the crew job card
  already shows).

The helpers are deliberately dependency-free: they operate on duck-typed
``prop`` / ``intake`` objects, so both the intake router and the quoting router
can call them without a circular import.
"""
import re
from typing import Optional


def _essentials(intake) -> dict:
    """The request's custom_fields dict, or an empty dict."""
    cf = getattr(intake, "custom_fields", None)
    return cf if isinstance(cf, dict) else {}


def _clean_str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _focus_label(value) -> str:
    """Render focus_areas (a list of slugs, or a free-text string) as a
    human phrase: ['kitchen','bathrooms'] -> 'Kitchen, Bathrooms'."""
    if isinstance(value, (list, tuple)):
        labels = [str(x).strip().replace("_", " ").title() for x in value if str(x).strip()]
        return ", ".join(labels)
    return _clean_str(value)


def fill_property_access_from_intake(prop, intake) -> bool:
    """Fill the Property's place-stable access fields from the request's on-site
    essentials, ONLY where the field is still empty (fill-if-missing) — never
    overwrite what an operator has entered. entry method + pets fold into
    ``access_notes`` (what the crew reads for "how do I get in / what's inside");
    parking goes to its own ``parking_notes`` column.

    Returns True if it changed anything, so a caller can skip a pointless write.
    """
    if prop is None or intake is None:
        return False
    cf = _essentials(intake)
    changed = False

    parking = _clean_str(cf.get("parking_notes"))
    if parking and not _clean_str(getattr(prop, "parking_notes", None)):
        prop.parking_notes = parking
        changed = True

    if not _clean_str(getattr(prop, "access_notes", None)):
        bits = []
        entry = _clean_str(cf.get("entry_method"))
        if entry:
            bits.append(f"Entry: {entry}")
        pets = _clean_str(cf.get("pets_detail"))
        if pets:
            bits.append(f"Pets: {pets}")
        if bits:
            prop.access_notes = " · ".join(bits)
            changed = True

    return changed


def _coerce_hhmm(value) -> Optional[str]:
    """Best-effort parse of a customer-entered check-in/out time into 24h
    'HH:MM' — what Property.check_in_time/check_out_time store (String(5)).

    Accepts '14:00', '9:00', '3pm', '3:00 PM', '11 am'. Returns None for
    anything it can't confidently parse (a date, 'flexible', a range), so the
    strict, length-5 column is never handed a bad or oversized value (which
    Postgres would reject outright)."""
    s = _clean_str(value).lower()
    if not s:
        return None
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", s)
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2) or 0)
    ampm = m.group(3)
    if ampm == "pm" and hour != 12:
        hour += 12
    elif ampm == "am" and hour == 12:
        hour = 0
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"


def fill_property_rental_from_intake(prop, intake) -> bool:
    """For an STR property, carry the request's rental specifics onto it,
    fill-if-missing — the counterpart to fill_property_access_from_intake for
    the vacation-rental fields that were being dropped at conversion.

    Check-in/out times land on the strict HH:MM columns when parseable (they
    show in the STR property form AND seed the iCal turnover engine's start/end
    times, which read prop.check_out_time / check_in_time — a per-feed override
    or operator edit still wins because this is fill-if-missing). Guest count,
    listing URL, turnover day, and any unparseable raw time are preserved on
    Property.custom_fields so nothing the customer told us is lost. No-op unless
    the property is STR. Returns True if it changed anything."""
    if prop is None or intake is None:
        return False
    if (getattr(prop, "property_type", "") or "").lower() != "str":
        return False
    changed = False
    extra = {}  # accumulates values destined for Property.custom_fields

    for raw_attr, col in (("check_in", "check_in_time"), ("check_out", "check_out_time")):
        raw = _clean_str(getattr(intake, raw_attr, None))
        if not raw or _clean_str(getattr(prop, col, None)):
            continue  # nothing to carry, or the property already has a value (wins)
        hhmm = _coerce_hhmm(raw)
        if hhmm:
            setattr(prop, col, hhmm)
            changed = True
        else:
            extra[raw_attr] = raw  # keep the raw phrasing rather than lose it

    guests = getattr(intake, "guests", None)
    if guests:
        extra["guests"] = guests
    cf = _essentials(intake)
    for key in ("listing_url", "turnover_day"):
        val = _clean_str(cf.get(key))
        if val:
            extra[key] = val

    if extra:
        current = dict(getattr(prop, "custom_fields", None) or {})
        merged = dict(current)
        for key, val in extra.items():
            # Key-level fill-if-missing: don't clobber a value already there.
            if key not in merged or merged.get(key) in (None, "", []):
                merged[key] = val
        if merged != current:
            # Reassign (not in-place mutate) so SQLAlchemy flags the JSON dirty.
            prop.custom_fields = merged
            changed = True

    return changed


def compose_job_notes_from_intake(base_notes: Optional[str], intake) -> str:
    """Append the per-visit request details (focus areas, special instructions,
    arrival window) to a job's notes, so the crew sees what the customer asked
    for on THIS visit. ``base_notes`` (from the quote) stays first; returns it
    unchanged when there is nothing to add."""
    base = _clean_str(base_notes)
    if intake is None:
        return base
    cf = _essentials(intake)

    lines = []
    focus = _focus_label(cf.get("focus_areas"))
    if focus:
        lines.append(f"Focus: {focus}")
    special = _clean_str(cf.get("special_instructions"))
    if special:
        lines.append(f"Special instructions: {special}")
    arrival = _clean_str(cf.get("arrival_window"))
    if arrival:
        lines.append(f"Arrival window: {arrival}")

    if not lines:
        return base
    extra = "\n".join(lines)
    # Don't double-append if this job's notes already carry the block (idempotent
    # re-conversion, or an operator who pasted it in).
    if extra in base:
        return base
    return f"{base}\n\n{extra}" if base else extra
