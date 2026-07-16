"""Editable service scopes (Settings → Service Scopes).

The list of services + their customer-facing scope drives the quote composer's
Service Type selector and the scope pre-fill, and must be operator-editable
(edit AND add), with defaults that match maineclean.co.
"""
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import AppSetting
from modules.settings.router import service_scopes_list, set_setting

client = TestClient(app)


def _clear():
    db = SessionLocal()
    try:
        db.query(AppSetting).filter(
            AppSetting.key.in_([
                "service_scopes", "service_scope_residential",
                "service_scope_commercial", "service_scope_str",
            ])
        ).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def clean():
    _clear()
    yield
    _clear()


def test_defaults_match_website_services():
    db = SessionLocal()
    try:
        services = service_scopes_list(db)
    finally:
        db.close()
    keys = [s["key"] for s in services]
    # The five services the maineclean.co scope-of-services covers.
    assert keys == ["residential", "deep", "move_in_out", "str", "commercial"]
    resi = next(s for s in services if s["key"] == "residential")
    assert "Kitchen" in resi["scope"] and "Bathrooms" in resi["scope"]
    deep = next(s for s in services if s["key"] == "deep")
    assert "Includes everything in the Maintenance Clean" in deep["scope"]


def test_legacy_scope_edit_is_migrated():
    """An operator's earlier Settings → General → Service Descriptions edit
    carries into the new list on first load."""
    db = SessionLocal()
    try:
        set_setting(db, "service_scope_residential", "My custom residential scope")
        db.commit()
        services = service_scopes_list(db)
    finally:
        db.close()
    resi = next(s for s in services if s["key"] == "residential")
    assert resi["scope"] == "My custom residential scope"


def test_add_and_edit_services_persists():
    # Start from defaults, edit one, add a brand-new service.
    services = client.get("/api/settings/service-scopes").json()["services"]
    services[0]["scope"] = "Edited residential scope"
    services.append({"key": "window_washing", "label": "Window Washing",
                     "scope": "Interior and exterior windows, screens, and sills."})
    r = client.put("/api/settings/service-scopes", json={"services": services})
    assert r.status_code == 200, r.text

    reloaded = client.get("/api/settings/service-scopes").json()["services"]
    keys = [s["key"] for s in reloaded]
    assert "window_washing" in keys
    resi = next(s for s in reloaded if s["key"] == "residential")
    assert resi["scope"] == "Edited residential scope"


def test_rejects_duplicate_and_bad_keys():
    dup = client.put("/api/settings/service-scopes", json={"services": [
        {"key": "residential", "label": "A", "scope": "x"},
        {"key": "residential", "label": "B", "scope": "y"},
    ]})
    assert dup.status_code == 400

    bad = client.put("/api/settings/service-scopes", json={"services": [
        {"key": "Bad Key!", "label": "A", "scope": "x"},
    ]})
    assert bad.status_code == 400

    empty = client.put("/api/settings/service-scopes", json={"services": []})
    assert empty.status_code == 400
