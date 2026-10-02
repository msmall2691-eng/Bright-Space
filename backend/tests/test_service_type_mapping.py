"""canonical_service_type: a rental request must not silently become residential.

Root cause of the mislabeled cottage-Airbnb: the map recognized only four STR
spellings (str / vacation-rental / airbnb / airbnb-turnover) and defaulted
everything else — "cottage", "short-term-rental", "rental", "vrbo" — to
residential. This broadens the map, adds a whole-token keyword rescue, and
normalizes separators, without ever producing a non-canonical value.
"""
import pytest

from modules.intake.normalize import canonical_service_type


@pytest.mark.parametrize("raw", [
    "str", "str-turnover", "airbnb", "airbnb-turnover", "vrbo", "vrbo-turnover",
    "vacation-rental", "short-term-rental", "rental", "turnover", "cottage", "cabin",
])
def test_rental_spellings_map_to_str(raw):
    assert canonical_service_type(raw) == "str", raw


@pytest.mark.parametrize("raw", [
    "vacation rental", "vacation_rental", "short term rental", "short_term_rental",
    "AIRBNB", "  Vrbo-Turnover  ",
])
def test_separators_and_case_are_normalized(raw):
    assert canonical_service_type(raw) == "str", raw


@pytest.mark.parametrize("raw", [
    "cottage cleaning", "airbnb turnover deep clean", "beach-rental",
])
def test_free_text_rental_is_rescued_by_keyword(raw):
    assert canonical_service_type(raw) == "str", raw


@pytest.mark.parametrize("raw", [
    "residential", "standard", "deep", "deep-cleaning", "move-in-out",
    "house", "home", "apartment", "condo",
])
def test_residential_spellings_stay_residential(raw):
    assert canonical_service_type(raw) == "residential", raw


@pytest.mark.parametrize("raw", [
    "commercial", "office", "retail", "commercial-cleaning", "industrial-cleaning",
])
def test_commercial_spellings_stay_commercial(raw):
    assert canonical_service_type(raw) == "commercial", raw


def test_industrial_does_not_false_match_str_as_a_substring():
    # "industrial" contains the substring "str" — the sniff is whole-token, so
    # it must resolve commercial, never str.
    assert canonical_service_type("industrial") == "commercial"


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_missing_service_defaults_quietly_to_residential(raw):
    assert canonical_service_type(raw) == "residential"


def test_genuine_unknown_defaults_to_residential():
    # Unrecognized but non-empty: still residential (canonical-safe), and the
    # function logs a breadcrumb (not asserted here) rather than failing.
    assert canonical_service_type("spaceship-detailing") == "residential"


def test_only_canonical_values_are_ever_produced():
    for raw in ["str", "cottage", "commercial", "office", "house", "zzz", "", None]:
        assert canonical_service_type(raw) in {"residential", "commercial", "str"}
