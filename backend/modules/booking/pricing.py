"""
Instant-quote pricing engine for the public booking form.

Rules are encoded as plain constants so they're easy to audit and tune
without touching application code. The output is a price *range* (min, max)
because the form doesn't capture enough detail to commit to a single
number — the operator finalizes the actual quote in BrightBase.

Defaults reflect mid-2026 Maine residential cleaning rates. Tune the
constants below if your rates drift. No env-var indirection on purpose:
making this file the single source of truth keeps surprises out of
production when you redeploy.
"""
from typing import Optional


# ── Base prices by service ─────────────────────────────────────────
# Includes the first 2 bedrooms + 1 bathroom + 1000 sqft. Add-ons below.
BASE_PRICE = {
    "residential": 120,
    "commercial":  180,
    "str":         110,  # STR turnover — smaller default footprint
}

# ── Per-additional-room ────────────────────────────────────────────
PER_EXTRA_BEDROOM_USD  = 25
PER_EXTRA_BATHROOM_USD = 18

# ── Per-sqft tier (above the first 1000) ───────────────────────────
SQFT_BAND_SIZE = 500
SQFT_BAND_PRICE_USD = 22

# ── Service multipliers ────────────────────────────────────────────
# Standard / move-in-out / deep-clean / etc. The booking form's
# free-text "frequency" field is normalized at the call-site.
FREQUENCY_DISCOUNT = {
    # one-time pays the base rate
    None:            1.00,
    "":              1.00,
    "one-time":      1.00,
    "weekly":        0.90,    # 10% off for weekly
    "biweekly":      0.95,    # 5%  off for biweekly
    "bi-weekly":     0.95,
    "monthly":       1.00,
}

# Deep-clean / move-in-out are typically requested by checking a
# checkbox or via the message field. Operator can confirm and adjust;
# the instant quote conservatively flags it via the range width.
DEEP_CLEAN_MULTIPLIER  = 1.50
MOVE_IN_OUT_MULTIPLIER = 1.65

# ── Range width ────────────────────────────────────────────────────
# We always return a min/max around the calculated mid so the customer
# sees a realistic span. Operator finalizes the exact number.
RANGE_BAND_PERCENT = 0.12   # ±12% around the mid


def _round_to_5(n: float) -> int:
    """Round to the nearest $5 so the displayed prices look like
    real numbers, not algorithm output."""
    return int(round(n / 5.0) * 5)


def estimate_price(
    *,
    service_type: str,
    bedrooms: Optional[int] = None,
    bathrooms: Optional[int] = None,
    square_footage: Optional[int] = None,
    frequency: Optional[str] = None,
    message: Optional[str] = None,
) -> dict:
    """Return {estimate_min, estimate_max, breakdown} for a booking.

    Conservative defaults so we never quote suspiciously low. Every
    component is reported back in ``breakdown`` for transparency and
    debugging.
    """
    svc = (service_type or "residential").lower()
    if svc not in BASE_PRICE:
        # Map common aliases the booking form might send.
        svc = {
            "airbnb-turnover":     "str",
            "vrbo-turnover":       "str",
            "vacation-rental":     "str",
            "str-turnover":        "str",
            "residential-cleaning":"residential",
            "commercial-cleaning": "commercial",
            "standard":            "residential",
            "deep":                "residential",
            "deep-cleaning":       "residential",
            "move-in-out":         "residential",
        }.get(svc, "residential")

    base = BASE_PRICE[svc]
    breakdown = {"base": base, "service_type": svc}

    # Extra rooms beyond the 2BR/1BA included in the base.
    extra_bd = max(0, (bedrooms or 0) - 2)
    extra_ba = max(0, (bathrooms or 0) - 1)
    bd_cost = extra_bd * PER_EXTRA_BEDROOM_USD
    ba_cost = extra_ba * PER_EXTRA_BATHROOM_USD
    breakdown["extra_bedrooms"]  = {"count": extra_bd, "subtotal": bd_cost}
    breakdown["extra_bathrooms"] = {"count": extra_ba, "subtotal": ba_cost}

    # Extra square footage beyond the first 1000.
    sqft_cost = 0
    if square_footage and square_footage > 1000:
        bands = (square_footage - 1000 + SQFT_BAND_SIZE - 1) // SQFT_BAND_SIZE
        sqft_cost = bands * SQFT_BAND_PRICE_USD
        breakdown["extra_sqft"] = {
            "square_footage": square_footage,
            "bands": bands,
            "subtotal": sqft_cost,
        }

    subtotal = base + bd_cost + ba_cost + sqft_cost

    # Deep-clean / move-in-out modifiers — keyword sniff on the message
    # so the website's "what kind of clean" radio lands the right rate
    # whether it's encoded in service_type or in the free-text message.
    msg = (message or "").lower()
    raw_st = (service_type or "").lower()
    multiplier = 1.0
    multiplier_label = None
    if "move" in raw_st or "move-in" in msg or "move-out" in msg or "move in" in msg or "move out" in msg:
        multiplier = MOVE_IN_OUT_MULTIPLIER
        multiplier_label = "move_in_out"
    elif "deep" in raw_st or "deep clean" in msg or "deep-clean" in msg:
        multiplier = DEEP_CLEAN_MULTIPLIER
        multiplier_label = "deep_clean"
    if multiplier != 1.0:
        breakdown["service_multiplier"] = {
            "label": multiplier_label,
            "factor": multiplier,
        }
        subtotal *= multiplier

    # Recurring-frequency discount.
    freq_key = (frequency or "").lower().strip()
    freq_factor = FREQUENCY_DISCOUNT.get(freq_key, 1.00)
    if freq_factor != 1.0:
        breakdown["frequency_discount"] = {
            "frequency": freq_key,
            "factor": freq_factor,
        }
        subtotal *= freq_factor

    mid = subtotal
    band = mid * RANGE_BAND_PERCENT
    estimate_min = _round_to_5(mid - band)
    estimate_max = _round_to_5(mid + band)

    # Floor: never quote below the base for the service.
    if estimate_min < base:
        estimate_min = base
    if estimate_max < estimate_min:
        estimate_max = estimate_min

    breakdown["pre_round_mid"] = round(mid, 2)
    return {
        "estimate_min": estimate_min,
        "estimate_max": estimate_max,
        "currency": "USD",
        "breakdown": breakdown,
    }
