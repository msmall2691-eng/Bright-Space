"""Address autocomplete + standardization, proxied to Google Places.

The Google API key is kept SERVER-SIDE (env GOOGLE_PLACES_API_KEY) and never
shipped to the browser — the frontend calls these endpoints instead. Degrades
gracefully: with no key configured the endpoints report enabled=false and the
address fields stay plain text inputs.
"""
import os
import logging

import httpx
from fastapi import APIRouter, Depends, Query

from modules.auth.router import require_role

logger = logging.getLogger(__name__)
router = APIRouter()

_AUTOCOMPLETE_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json"
_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"


def _key() -> str:
    return os.getenv("GOOGLE_PLACES_API_KEY", "").strip()


@router.get("/config", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def geo_config():
    """Tells the UI whether address autocomplete is available."""
    return {"enabled": bool(_key())}


@router.get("/autocomplete", dependencies=[Depends(require_role("admin", "manager"))])
def autocomplete(q: str = Query(..., min_length=3, max_length=200)):
    """Street-address suggestions for a partial query (US only)."""
    key = _key()
    if not key:
        return {"enabled": False, "predictions": []}
    try:
        r = httpx.get(_AUTOCOMPLETE_URL, params={
            "input": q, "key": key, "types": "address", "components": "country:us",
        }, timeout=8)
        data = r.json()
    except Exception as e:
        logger.warning("[geo] autocomplete failed: %s", e)
        return {"enabled": True, "predictions": [], "error": "lookup_failed"}
    preds = [
        {"description": p.get("description", ""), "place_id": p.get("place_id", "")}
        for p in data.get("predictions", [])
    ]
    return {"enabled": True, "predictions": preds}


def _component(comps, type_, short=False):
    for c in comps:
        if type_ in c.get("types", []):
            return c.get("short_name" if short else "long_name", "")
    return ""


@router.get("/place", dependencies=[Depends(require_role("admin", "manager"))])
def place(place_id: str = Query(..., min_length=1, max_length=400)):
    """Resolve a place_id to standardized street/city/state/zip + lat/lng."""
    key = _key()
    if not key:
        return {"enabled": False}
    try:
        r = httpx.get(_DETAILS_URL, params={
            "place_id": place_id, "key": key,
            "fields": "address_component,geometry",
        }, timeout=8)
        res = r.json().get("result", {})
    except Exception as e:
        logger.warning("[geo] place details failed: %s", e)
        return {"enabled": True, "error": "lookup_failed"}

    comps = res.get("address_components", [])
    loc = (res.get("geometry", {}) or {}).get("location", {}) or {}
    street = f"{_component(comps, 'street_number')} {_component(comps, 'route')}".strip()
    city = (_component(comps, "locality")
            or _component(comps, "sublocality")
            or _component(comps, "administrative_area_level_3"))
    return {
        "enabled": True,
        "address": street,
        "city": city,
        "state": _component(comps, "administrative_area_level_1", short=True),
        "zip_code": _component(comps, "postal_code"),
        "lat": loc.get("lat"),
        "lng": loc.get("lng"),
    }
