"""Customer prep policies are resolved by service type.

The bug: a Short-Term Rental turnover quote showed the residential prep notes
("pick up your personal items and clutter", "secure pets during the visit"),
which don't apply to an Airbnb turnover. quote_policies_text now returns the
service-appropriate block, honoring per-service and legacy global overrides.
"""
from database.db import SessionLocal
from modules.settings.router import (
    quote_policies_text, set_setting,
    DEFAULT_QUOTE_POLICIES, DEFAULT_QUOTE_POLICIES_STR, DEFAULT_QUOTE_POLICIES_COMMERCIAL,
)

_KEYS = ("quote_policies", "quote_policies_str", "quote_policies_commercial",
         "quote_policies_residential")


def _clear(db):
    for k in _KEYS:
        set_setting(db, k, "")
    db.commit()


def test_str_gets_turnover_notes_not_residential():
    db = SessionLocal()
    try:
        _clear(db)
        text = quote_policies_text(db, "str")
        assert text == DEFAULT_QUOTE_POLICIES_STR
        # The residential lines that read wrong on a turnover are gone.
        assert "secure pets" not in text.lower()
        assert "clutter" not in text.lower()
        # And it carries turnover-specific guidance.
        assert "turn the unit" in text.lower()
    finally:
        _clear(db); db.close()


def test_residential_and_unknown_get_the_home_default():
    db = SessionLocal()
    try:
        _clear(db)
        assert quote_policies_text(db, "residential") == DEFAULT_QUOTE_POLICIES
        assert quote_policies_text(db, None) == DEFAULT_QUOTE_POLICIES
        # Home-clean variants share the residential block.
        assert quote_policies_text(db, "deep") == DEFAULT_QUOTE_POLICIES
    finally:
        _clear(db); db.close()


def test_commercial_default():
    db = SessionLocal()
    try:
        _clear(db)
        assert quote_policies_text(db, "commercial") == DEFAULT_QUOTE_POLICIES_COMMERCIAL
    finally:
        _clear(db); db.close()


def test_legacy_global_override_applies_to_home_cleans_only():
    db = SessionLocal()
    try:
        _clear(db)
        set_setting(db, "quote_policies", "Global custom note."); db.commit()
        # Home cleans honor the operator's global override…
        assert quote_policies_text(db, "residential") == "Global custom note."
        assert quote_policies_text(db, None) == "Global custom note."
        # …but STR/commercial do NOT (that mismatch is the bug being fixed).
        assert quote_policies_text(db, "str") == DEFAULT_QUOTE_POLICIES_STR
        assert quote_policies_text(db, "commercial") == DEFAULT_QUOTE_POLICIES_COMMERCIAL
    finally:
        _clear(db); db.close()


def test_per_service_override_wins():
    db = SessionLocal()
    try:
        _clear(db)
        set_setting(db, "quote_policies_str", "Custom turnover note."); db.commit()
        assert quote_policies_text(db, "str") == "Custom turnover note."
    finally:
        _clear(db); db.close()
