"""Client-data enrichment, Phase 1: structured property specs.

Two guarantees:
  1. bedrooms / bathrooms / square_footage / year_built persist through
     create + update and are surfaced by the property serializer (they were
     stored-but-invisible before — the columns existed since migration 025/056
     but the API never read or wrote them).
  2. GET /api/properties/lookup-specs is owner-gated and best-effort: disabled
     or unconfigured → {"enabled": False, "specs": None} and never raises; when
     enabled it returns the provider's specs. It must NOT be able to override
     the residential|commercial|str classification (that stays a human choice).
"""
import pytest
from unittest.mock import patch

from database.db import SessionLocal
from database.models import AppSetting, Client, Property
from modules.settings.router import set_setting
from modules.properties.router import (
    create_property, update_property, lookup_specs,
    PropertyCreate, PropertyUpdate,
)


@pytest.fixture
def client_row():
    db = SessionLocal()
    c = Client(name="Enrichment Test", email="enrich@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield c, db
    db.rollback()
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit()
    db.close()


@pytest.fixture
def settings_db():
    s = SessionLocal()
    yield s
    for k in ("property_enrichment_enabled", "rentcast_api_key"):
        s.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    s.commit(); s.close()


# ── Persistence ──────────────────────────────────────────────────────────────

def test_create_persists_specs_and_surfaces_them(client_row):
    c, db = client_row
    out = create_property(PropertyCreate(
        client_id=c.id, name="4 Red Barn Circle", address="4 Red Barn Circle",
        bedrooms=3, bathrooms=2.5, square_footage=1800, year_built=1998,
    ), db=db, org_id=1)
    # Surfaced in the API shape...
    assert out["bedrooms"] == 3
    assert out["bathrooms"] == 2.5   # Float: the half-bath survives
    assert out["square_footage"] == 1800
    assert out["year_built"] == 1998
    # ...and actually written to the row.
    fresh = db.query(Property).filter(Property.id == out["id"]).first()
    assert (fresh.bedrooms, fresh.bathrooms, fresh.square_footage, fresh.year_built) == (3, 2.5, 1800, 1998)


def test_specs_default_to_none_when_omitted(client_row):
    c, db = client_row
    out = create_property(PropertyCreate(
        client_id=c.id, name="No Specs", address="1 Blank St",
    ), db=db, org_id=1)
    assert out["bedrooms"] is None
    assert out["bathrooms"] is None
    assert out["square_footage"] is None
    assert out["year_built"] is None


def test_update_sets_specs(client_row):
    c, db = client_row
    out = create_property(PropertyCreate(
        client_id=c.id, name="Updatable", address="2 Change Rd", square_footage=1500,
    ), db=db, org_id=1)
    updated = update_property(
        out["id"],
        PropertyUpdate(square_footage=2000, year_built=2005, bedrooms=4),
        db=db, org_id=1,
    )
    assert updated["square_footage"] == 2000
    assert updated["year_built"] == 2005
    assert updated["bedrooms"] == 4


# ── Lookup endpoint ──────────────────────────────────────────────────────────

def test_lookup_disabled_returns_no_specs(settings_db):
    out = lookup_specs(address="24 Pine St", city=None, state=None, zip_code=None, db=settings_db)
    assert out == {"enabled": False, "specs": None}


def test_lookup_uses_provider_when_enabled(settings_db):
    set_setting(settings_db, "property_enrichment_enabled", "true")
    set_setting(settings_db, "rentcast_api_key", "rc"); settings_db.commit()
    fake = {"square_footage": 1800, "bedrooms": 3, "bathrooms": 2.5, "year_built": 1998,
            "property_type": "Single Family"}
    with patch("services.property_media.property_specs", return_value=fake) as ps:
        out = lookup_specs(address="24 Pine St", city="Portland", state="ME", zip_code="04101", db=settings_db)
    assert out["enabled"] is True
    assert out["specs"]["square_footage"] == 1800
    assert out["specs"]["year_built"] == 1998
    assert ps.called
    # The composed address (city/state/zip folded in) is what reaches the provider.
    called_addr = ps.call_args.args[0]
    assert "24 Pine St" in called_addr and "Portland" in called_addr


def test_lookup_provider_type_is_passthrough_only(settings_db):
    """The provider's own property_type comes back for display, but it's the
    frontend's job never to apply it over residential|commercial|str. The
    endpoint itself must not mutate any property, so a lookup for a made-up
    address simply returns whatever the provider gave (here: None -> no match)."""
    set_setting(settings_db, "property_enrichment_enabled", "true")
    set_setting(settings_db, "rentcast_api_key", "rc"); settings_db.commit()
    with patch("services.property_media.property_specs", return_value=None):
        out = lookup_specs(address="Nowhere at all", city=None, state=None, zip_code=None, db=settings_db)
    assert out == {"enabled": True, "specs": None}
