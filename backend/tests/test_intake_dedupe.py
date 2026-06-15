"""Tests for intake source normalization + duplicate-client grouping (audit C)."""
from types import SimpleNamespace

from modules.intake.normalize import normalize_source
from scripts.merge_duplicate_clients import find_duplicate_groups, client_keys


# ── source normalization ──

def test_source_case_collapses():
    assert normalize_source("Website") == "website"
    assert normalize_source("website") == "website"
    assert normalize_source("  WEBSITE ") == "website"


def test_source_synonyms():
    assert normalize_source("contact form") == "website"
    assert normalize_source("maineclean.co") == "website"
    assert normalize_source("phone call") == "phone"
    assert normalize_source("text message") == "sms"


def test_source_empty_defaults_website():
    assert normalize_source("") == "website"
    assert normalize_source(None) == "website"


def test_source_unknown_passthrough_lowercased():
    assert normalize_source("Referral") == "referral"


# ── duplicate-client grouping ──

def _c(id, email=None, phone=None, org_id=1, created_at=None):
    return SimpleNamespace(id=id, email=email, phone=phone, org_id=org_id, created_at=created_at)


def test_groups_by_email_case_insensitive():
    clients = [_c(1, email="JEFF@x.com"), _c(2, email="jeff@x.com"), _c(3, email="other@x.com")]
    groups = find_duplicate_groups(clients)
    assert len(groups) == 1
    assert {c.id for c in groups[0]} == {1, 2}


def test_groups_by_phone_last10():
    clients = [_c(1, phone="+1 (207) 555-1234"), _c(2, phone="2075551234")]
    groups = find_duplicate_groups(clients)
    assert len(groups) == 1 and {c.id for c in groups[0]} == {1, 2}


def test_transitive_merge_via_shared_keys():
    # A shares email with B; B shares phone with C → all three group together.
    clients = [
        _c(1, email="a@x.com"),
        _c(2, email="a@x.com", phone="2075550000"),
        _c(3, phone="207-555-0000"),
    ]
    groups = find_duplicate_groups(clients)
    assert len(groups) == 1 and {c.id for c in groups[0]} == {1, 2, 3}


def test_different_orgs_do_not_merge():
    clients = [_c(1, email="a@x.com", org_id=1), _c(2, email="a@x.com", org_id=2)]
    assert find_duplicate_groups(clients) == []


def test_no_contact_no_group():
    assert client_keys(_c(1)) == set()
    assert find_duplicate_groups([_c(1), _c(2)]) == []
