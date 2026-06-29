"""Property media + data helpers for quotes.

- Google Street View Static API: a front-of-house photo by address.
- RentCast property record: square footage / beds / baths / year built by address.

Both are OPT-IN and key-gated (Settings → Property Photos & Data). Every call is
best-effort and returns None on any failure — a missing key, no coverage, a slow
network, or a provider error must never break quote creation or sending.
"""

import json
import logging
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

_SV_BASE = "https://maps.googleapis.com/maps/api/streetview"
_RENTCAST_BASE = "https://api.rentcast.io/v1/properties"


def _get(db, key):
    """Read a Settings row (best-effort)."""
    try:
        from modules.settings.router import get_setting
        return (get_setting(db, key) or "").strip() or None
    except Exception:
        return None


def _truthy(v) -> bool:
    return (v or "").strip().lower() in ("1", "true", "yes", "on")


# ── Street View ──────────────────────────────────────────────────────────────

def street_view_enabled(db) -> bool:
    """True when the owner enabled photos AND a Google Maps key is configured."""
    return _truthy(_get(db, "property_photo_enabled")) and bool(_get(db, "google_maps_api_key"))


def has_street_view(address: str, api_key: str) -> bool:
    """True when Google actually has imagery for this address. Uses the free
    metadata endpoint so we never embed Google's generic "no imagery" gray tile."""
    if not (address and api_key):
        return False
    try:
        qs = urllib.parse.urlencode({"size": "640x360", "location": address, "key": api_key})
        with urllib.request.urlopen(f"{_SV_BASE}/metadata?{qs}", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("status") == "OK"
    except Exception as e:
        logger.warning(f"[street-view] metadata check failed: {e}")
        return False


def street_view_bytes(address: str, api_key: str, size: str = "640x360") -> bytes | None:
    """Front-of-house JPEG for the address, or None when there's no coverage."""
    if not has_street_view(address, api_key):
        return None
    try:
        qs = urllib.parse.urlencode({"size": size, "location": address, "fov": "80", "key": api_key})
        with urllib.request.urlopen(f"{_SV_BASE}?{qs}", timeout=8) as resp:
            return resp.read()
    except Exception as e:
        logger.warning(f"[street-view] image fetch failed: {e}")
        return None


# ── RentCast property data ───────────────────────────────────────────────────

def enrichment_enabled(db) -> bool:
    return _truthy(_get(db, "property_enrichment_enabled")) and bool(_get(db, "rentcast_api_key"))


def property_specs(address: str, api_key: str) -> dict | None:
    """Look up structured specs for an address via RentCast. Returns a small,
    normalized dict (only the keys we found) or None. Never raises."""
    if not (address and api_key):
        return None
    try:
        qs = urllib.parse.urlencode({"address": address})
        req = urllib.request.Request(f"{_RENTCAST_BASE}?{qs}", headers={"X-Api-Key": api_key})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        # RentCast returns a list of matching records; take the first.
        rec = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
        if not rec:
            return None
        out = {}
        if rec.get("squareFootage"):
            out["square_footage"] = int(rec["squareFootage"])
        if rec.get("bedrooms") is not None:
            out["bedrooms"] = int(rec["bedrooms"])
        if rec.get("bathrooms") is not None:
            out["bathrooms"] = float(rec["bathrooms"])
        if rec.get("yearBuilt"):
            out["year_built"] = int(rec["yearBuilt"])
        if rec.get("propertyType"):
            out["property_type"] = str(rec["propertyType"])
        return out or None
    except Exception as e:
        logger.warning(f"[property-data] lookup failed: {e}")
        return None
