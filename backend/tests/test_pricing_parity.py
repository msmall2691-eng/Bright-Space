"""Cross-repo pricing parity contract.

tests/pricing_vectors.json is a byte-for-byte copy of maineclean.co's
shared/pricing-vectors.json — the single source of expected estimate outputs,
generated from the canonical TypeScript engine (@shared/pricing). This test
asserts the Python port in modules/booking/pricing.py::estimate_price
reproduces every vector.

If maineclean changes a rate/constant it must regenerate the vectors; that diff
lands here on the next sync and THIS test fails until the Python engine is
brought back in line — so the customer-facing number (TS) and the operator-
facing number (Python) cannot silently drift apart. When you intentionally
change pricing: edit @shared/pricing, mirror it in pricing.py, regenerate
shared/pricing-vectors.json, and copy it here in the same change.
"""
import json
from pathlib import Path

import pytest

from modules.booking.pricing import estimate_price

_VECTORS = json.loads((Path(__file__).parent / "pricing_vectors.json").read_text())["vectors"]


def _service_type_for(clean_type: str) -> str:
    # The vectors speak the client's "standard"/"deep" cleanType; the Python
    # engine keys off a service_type string. "residential" is the plain
    # standard clean; "deep" trips the deep-clean multiplier + $225 floor.
    return "deep" if clean_type == "deep" else "residential"


def test_vector_file_is_non_trivial():
    # Guard against a truncated/empty contract file silently passing the suite.
    assert len(_VECTORS) > 100


@pytest.mark.parametrize("vec", _VECTORS, ids=lambda v: json.dumps(v["input"], separators=(",", ":")))
def test_python_engine_matches_shared_vectors(vec):
    i = vec["input"]
    result = estimate_price(
        service_type=_service_type_for(i["cleanType"]),
        bathrooms=i["bathrooms"],
        square_footage=i["sqft"],
        frequency=i["frequency"],
        condition=i["condition"],
        pet_hair=i["petHair"],
    )
    assert result["estimate_min"] == vec["expected"]["min"], (
        f"min drift for {i}: python {result['estimate_min']} vs contract {vec['expected']['min']}"
    )
    assert result["estimate_max"] == vec["expected"]["max"], (
        f"max drift for {i}: python {result['estimate_max']} vs contract {vec['expected']['max']}"
    )
