"""Pins the July-2026 audit L1/L3 fix — combine_address must not re-append
components already present in the base string. The bug surfaced on the
customer-facing quote page as "Keystone Drive, Waterboro, ME, 04061, ME"
(state doubled), because maineclean.co's /book form assembles the full
"street, city, ME, zip" string into LeadIntake.address, and then
convert_intake_to_quote joined intake.state ("ME") onto it a second time.
"""

from utils.address import combine_address


def test_does_not_reappend_state_baked_into_base():
    result = combine_address(
        "Keystone Drive, Waterboro, ME, 04061", None, "ME", None,
    )
    assert result == "Keystone Drive, Waterboro, ME, 04061"


def test_appends_when_components_genuinely_missing():
    assert combine_address("155 Main St", "Portland", "ME", "04101") == (
        "155 Main St, Portland, ME, 04101"
    )


def test_dedup_is_case_insensitive():
    assert combine_address("123 Elm St, Portland, me", None, "ME", None) == (
        "123 Elm St, Portland, me"
    )


def test_handles_missing_house_number_case():
    # Nominatim can strip the house number (audit L2); the combine call still
    # produces a sane string even when base has no leading number.
    assert combine_address("Keystone Drive", "Waterboro", "ME", "04061") == (
        "Keystone Drive, Waterboro, ME, 04061"
    )


def test_drops_empty_and_whitespace_components():
    assert combine_address("1 Main St", "", "ME", "  ") == "1 Main St, ME"


def test_empty_input_returns_empty_string():
    assert combine_address(None, None, None, None) == ""
    assert combine_address("", "", "", "") == ""


def test_does_not_append_the_same_value_twice_in_one_call():
    assert combine_address("123 Oak", "Portland", "ME", "ME") == "123 Oak, Portland, ME"


def test_keeps_city_when_street_name_contains_city_word():
    """Regression for the codex P2 on PR #527. Whitespace tokenization
    used to drop "Portland" because "12 Portland St" tokenized to
    ["12", "portland", "st"]. Address components are comma-delimited,
    not word-delimited — the street's words are not city candidates."""
    assert combine_address("12 Portland St", "Portland", "ME", "04101") == (
        "12 Portland St, Portland, ME, 04101"
    )


def test_still_skips_city_when_it_is_its_own_comma_component():
    assert combine_address("12 Elm St, Portland", "Portland", "ME", "04101") == (
        "12 Elm St, Portland, ME, 04101"
    )
