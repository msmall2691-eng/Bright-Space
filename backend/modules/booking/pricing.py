"""
Instant-quote pricing engine for the public booking form.

This is a Python port of the maineclean.co InstantEstimate calculator
(client/src/components/ui/InstantEstimate.tsx). The two engines MUST
stay in lock-step: the customer sees a number in the browser, then
Bright-Space recomputes here whenever the wire payload doesn't carry
one — and if the two engines diverge, the operator gets a different
price than the customer was quoted.

Formula (mirrors the client):
    labor  = (sqft_units + bath_adj + condition_units + pet_units) * service_mult
    raw    = labor * frequency_factor * RATE_PER_UNIT
    mid    = max(min_job, round_to_5(raw))
    range  = mid ± 4%, each rounded to $5

Any change to constants here must be mirrored in InstantEstimate.tsx
or the customer-facing quote and the Bright-Space stored quote will
drift again. That drift is exactly the bug this file was rewritten
to eliminate.
"""
import math
from typing import Optional


# ── Rate per labor unit ────────────────────────────────────────────
RATE_PER_UNIT = 60  # dollars per labor-unit

# ── Minimum job floor ──────────────────────────────────────────────
MIN_JOB_STANDARD = 130
MIN_JOB_DEEP     = 225

# ── Condition surcharges (labor units) ─────────────────────────────
# Accept "maintenance" (client's key) and "maintained" (legacy Bright-Space
# alias) so payloads from either shape land on the same 0-unit tier.
CONDITION_UNITS = {
    None:          0.0,
    "":            0.0,
    "maintenance": 0.0,
    "maintained":  0.0,
    "moderate":    0.50,
    "heavy":       1.00,
}

# ── Pet-hair surcharges (labor units) ──────────────────────────────
PET_UNITS = {
    None:    0.0,
    "":      0.0,
    "none":  0.0,
    "some":  0.30,
    "heavy": 0.60,
}

# ── Frequency multipliers ──────────────────────────────────────────
# Biweekly is the baseline (1.0). Weekly = 15% off, monthly = 15% surcharge,
# one-time = 50% surcharge. Do NOT restructure this as "discount off one-time"
# — that model diverges from the customer-shown quote.
FREQUENCY_FACTOR = {
    None:         1.0,
    "":           1.0,
    "weekly":     0.85,
    "biweekly":   1.0,
    "bi-weekly":  1.0,
    "monthly":    1.15,
    "one-time":   1.50,
    "onetime":    1.50,
    "one time":   1.50,
}

# ── Range width ────────────────────────────────────────────────────
# Client shows ±4%; mirror it so the visible range matches by construction.
RANGE_BAND_PERCENT = 0.04

# Custom-quote services — client shows no instant number for these; the
# operator prices them by hand. When the client doesn't send an estimate
# for one of these, we return zero range so downstream code (opportunity
# amount, seed unit_price) treats it as "operator finalize" rather than
# inventing a residential-looking price.
_CUSTOM_QUOTE_SERVICES = {
    "str", "vacation-rental", "airbnb", "airbnb-turnover",
    "vrbo-turnover", "str-turnover", "commercial", "commercial-cleaning",
    "office",
}

# Default sqft matches the client's initial slider value.
_DEFAULT_SQFT = 2000


def _js_round(n: float) -> int:
    """JS Math.round for positive numbers — half rounds UP, not banker's.
    We use this everywhere the client uses Math.round so the two engines
    produce identical output on the same input."""
    return int(math.floor(n + 0.5))


def _round_to_5(n: float) -> int:
    """Round to the nearest $5, JS-compatible."""
    return _js_round(n / 5.0) * 5


def _sqft_units(sf: int) -> float:
    """Piecewise sqft → labor units. Small homes have a steep marginal
    rate; larger homes flatten out. Matches InstantEstimate.tsx exactly."""
    if sf <= 1500:
        return sf / 680.0
    if sf <= 3000:
        return 1500 / 680.0 + (sf - 1500) / 1050.0
    return 1500 / 680.0 + 1500 / 1050.0 + (sf - 3000) / 1400.0


def _deep_multiplier(sf: int) -> float:
    """Deep-clean multiplier scales with home size."""
    if sf <= 1200:
        return 1.60
    if sf <= 2000:
        return 1.65
    if sf <= 3000:
        return 1.75
    return 1.80


def estimate_price(
    *,
    service_type: str,
    bedrooms: Optional[int] = None,
    bathrooms: Optional[float] = None,
    square_footage: Optional[int] = None,
    frequency: Optional[str] = None,
    message: Optional[str] = None,
    pet_hair: Optional[str] = None,
    condition: Optional[str] = None,
) -> dict:
    """Return {estimate_min, estimate_max, breakdown} for a booking.

    Ported from the maineclean.co InstantEstimate calculator so the range
    the customer saw and the range Bright-Space stores agree by construction.

    ``bedrooms`` is accepted for signature compatibility but not used — the
    client engine sizes on sqft + bathrooms + condition/pet only.
    """
    svc = (service_type or "").lower().strip()
    msg = (message or "").lower()

    if svc in _CUSTOM_QUOTE_SERVICES:
        return {
            "estimate_min": 0,
            "estimate_max": 0,
            "currency": "USD",
            "breakdown": {"service_type": svc, "custom_quote": True},
        }

    # Detect deep-clean / move-in-out from service_type OR the message text
    # — the contact form has no dedicated field, customers write it in.
    is_deep = "deep" in svc or "deep clean" in msg or "deep-clean" in msg
    is_move = (
        "move" in svc
        or "move-in" in msg or "move-out" in msg
        or "move in" in msg or "move out" in msg
    )

    min_job = MIN_JOB_DEEP if (is_deep or is_move) else MIN_JOB_STANDARD

    sf = int(square_footage) if square_footage else _DEFAULT_SQFT
    sqft_units = _sqft_units(sf)

    ba = float(bathrooms) if bathrooms not in (None, "") else 1.0
    bath_adj = max(0.0, (ba - 1) * 0.40)

    cond_key = (condition or "").lower().strip() or None
    cond_units = CONDITION_UNITS.get(cond_key, 0.0)

    pet_key = (pet_hair or "").lower().strip() or None
    pet_units = PET_UNITS.get(pet_key, 0.0)

    if is_deep:
        service_mult = _deep_multiplier(sf)
        mult_label = "deep_clean"
    elif is_move:
        # Move-in-out isn't in the client UI, but the earlier Bright-Space
        # engine priced it 65% above standard. Keep that so operators using
        # the instant-quote endpoint directly still get a sensible number.
        service_mult = 1.65
        mult_label = "move_in_out"
    else:
        service_mult = 1.0
        mult_label = None

    labor = (sqft_units + bath_adj + cond_units + pet_units) * service_mult

    freq_key = (frequency or "").lower().strip() or None
    freq_factor = FREQUENCY_FACTOR.get(freq_key, 1.0)

    raw = labor * freq_factor * RATE_PER_UNIT
    rounded = _round_to_5(raw)
    final = max(min_job, rounded)

    estimate_min = _round_to_5(final * (1.0 - RANGE_BAND_PERCENT))
    estimate_max = _round_to_5(final * (1.0 + RANGE_BAND_PERCENT))

    breakdown = {
        "service_type": svc or "residential",
        "min_job": min_job,
        "sqft": sf,
        "sqft_units": round(sqft_units, 4),
        "bathrooms": ba,
        "bath_adj_units": round(bath_adj, 4),
        "condition_units": cond_units,
        "pet_units": pet_units,
        "service_multiplier": (
            {"label": mult_label, "factor": service_mult} if mult_label else None
        ),
        "frequency_factor": freq_factor,
        "labor": round(labor, 4),
        "rate_per_unit": RATE_PER_UNIT,
        "raw": round(raw, 2),
        "final_mid": final,
    }

    return {
        "estimate_min": estimate_min,
        "estimate_max": estimate_max,
        "currency": "USD",
        "breakdown": breakdown,
    }
