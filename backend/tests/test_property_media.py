"""Street View photo + RentCast enrichment: opt-in, key-gated, graceful.

The feature must be invisible (no photo, no lookup, no errors) until the owner
enables it AND configures a key — and it must never break quote flows.
"""
import pytest
from unittest.mock import patch

from database.db import SessionLocal
from database.models import AppSetting, Client, Quote
from modules.settings.router import set_setting, get_property_media
import services.property_media as pm
from modules.quoting.router import _property_photo_url, property_lookup


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    for k in ("property_photo_enabled", "google_maps_api_key",
              "property_enrichment_enabled", "rentcast_api_key"):
        s.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    s.commit(); s.close()


def test_street_view_disabled_by_default(db):
    assert pm.street_view_enabled(db) is False
    # Enabled flag alone isn't enough — a key is required too.
    set_setting(db, "property_photo_enabled", "true"); db.commit()
    assert pm.street_view_enabled(db) is False
    set_setting(db, "google_maps_api_key", "k"); db.commit()
    assert pm.street_view_enabled(db) is True


def test_property_photo_url_only_when_enabled_and_addressed(db):
    q = Quote(client_id=1, quote_number="QT-PM-1", items=[], subtotal=0, tax_rate=0,
              tax=0, discount=0, total=0, status="draft",
              public_token="tok-pm-1", address="24 Pine St, Portland, ME")
    # Disabled → no URL.
    assert _property_photo_url(q, db) is None
    set_setting(db, "property_photo_enabled", "true")
    set_setting(db, "google_maps_api_key", "k"); db.commit()
    url = _property_photo_url(q, db)
    assert url and url.endswith("/api/quotes/public/tok-pm-1/property-photo")
    # No address → still None even when enabled.
    q.address = None
    assert _property_photo_url(q, db) is None


def test_get_property_media_never_leaks_keys(db):
    set_setting(db, "google_maps_api_key", "secret-key-123")
    set_setting(db, "rentcast_api_key", "rc-secret"); db.commit()
    out = get_property_media(db=db)
    assert out["google_maps_key_set"] is True and out["rentcast_key_set"] is True
    assert "secret-key-123" not in str(out) and "rc-secret" not in str(out)


def test_property_lookup_disabled_returns_no_specs(db):
    out = property_lookup(address="24 Pine St", db=db)
    assert out == {"enabled": False, "specs": None}


def test_property_lookup_uses_provider_when_enabled(db):
    set_setting(db, "property_enrichment_enabled", "true")
    set_setting(db, "rentcast_api_key", "rc"); db.commit()
    with patch("services.property_media.property_specs",
               return_value={"square_footage": 1800, "bedrooms": 3, "bathrooms": 2}) as ps:
        out = property_lookup(address="24 Pine St, Portland, ME", db=db)
    assert out["enabled"] is True
    assert out["specs"]["square_footage"] == 1800
    assert ps.called


def test_has_street_view_false_on_zero_results():
    # Metadata "ZERO_RESULTS" → no embed (avoids Google's generic gray tile).
    import io, json
    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps({"status": "ZERO_RESULTS"}).encode()
    with patch("urllib.request.urlopen", return_value=_Resp()):
        assert pm.has_street_view("nowhere", "key") is False
