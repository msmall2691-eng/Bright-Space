"""Geocoding + leg distances for the payroll mileage report.

Same server-side-key pattern as modules/geo/router.py: the Google key
(GOOGLE_PLACES_API_KEY) never leaves the backend, and everything degrades
gracefully without it —

  * geocode() returns None when no key is configured (or the lookup fails),
    so rows simply stay un-geocoded and the mileage report flags the stop
    instead of erroring.
  * leg_miles() uses the Google Routes/Distance Matrix road distance when the
    key exists; otherwise (or on any API hiccup) it falls back to the
    haversine straight-line distance × ROAD_FACTOR and marks the leg
    estimated=True so the UI can label it honestly.

Coordinates are CACHED on the row (Property.lat/lng, User.home_lat/lng —
migration 092) so each address geocodes exactly once. Geocoding happens
lazily at computation time (R1: no new background ticks); callers commit the
session after a mileage pass to persist any cache fills.
"""
from __future__ import annotations

import logging
import math
import os
from typing import Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
_DISTANCE_URL = "https://maps.googleapis.com/maps/api/distancematrix/json"

# Straight-line → road-distance fudge factor for the no-key fallback. Roads
# aren't straight; ~1.3 is the commonly used planning multiplier and reads as
# "estimated" everywhere it's shown.
ROAD_FACTOR = 1.3

_EARTH_RADIUS_MILES = 3958.7613

Coords = Tuple[float, float]


def _key() -> str:
    return os.getenv("GOOGLE_PLACES_API_KEY", "").strip()


def geocode(address: str) -> Optional[Coords]:
    """Resolve a free-text address to (lat, lng) via Google's Geocoding API.
    None when no key is configured, the address is blank, or the lookup fails
    — callers treat None as "unknown stop", never as an error."""
    addr = (address or "").strip()
    key = _key()
    if not addr or not key:
        return None
    try:
        r = httpx.get(_GEOCODE_URL, params={"address": addr, "key": key}, timeout=8)
        results = r.json().get("results") or []
        loc = (results[0].get("geometry", {}) or {}).get("location") if results else None
        if loc and loc.get("lat") is not None and loc.get("lng") is not None:
            return (float(loc["lat"]), float(loc["lng"]))
    except Exception as e:  # network, quota, malformed body — all soft-fail
        logger.warning("[geocoding] geocode failed for %r: %s", addr[:80], e)
    return None


def ensure_property_coords(prop) -> Optional[Coords]:
    """Cached coords for a Property, geocoding + writing back on first need.
    Caller commits the session to persist the cache fill."""
    if prop is None:
        return None
    if prop.lat is not None and prop.lng is not None:
        return (prop.lat, prop.lng)
    parts = [prop.address or prop.name, prop.city, prop.state, prop.zip_code]
    coords = geocode(", ".join(p for p in parts if p))
    if coords:
        prop.lat, prop.lng = coords
    return coords


def ensure_user_home_coords(user) -> Optional[Coords]:
    """Cached home coords for a User (cleaner), geocoding + writing back on
    first need. None when no home address is on file. Caller commits."""
    if user is None or not (user.home_address or "").strip():
        return None
    if user.home_lat is not None and user.home_lng is not None:
        return (user.home_lat, user.home_lng)
    coords = geocode(user.home_address)
    if coords:
        user.home_lat, user.home_lng = coords
    return coords


def haversine_miles(a: Coords, b: Coords) -> float:
    """Great-circle (straight-line) distance in miles."""
    lat1, lng1 = math.radians(a[0]), math.radians(a[1])
    lat2, lng2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return _EARTH_RADIUS_MILES * 2 * math.asin(math.sqrt(h))


def _road_miles(a: Coords, b: Coords) -> Optional[float]:
    """Driving distance via Google's Distance Matrix. None on any failure so
    the caller falls back to the haversine estimate."""
    key = _key()
    if not key:
        return None
    try:
        r = httpx.get(_DISTANCE_URL, params={
            "origins": f"{a[0]},{a[1]}",
            "destinations": f"{b[0]},{b[1]}",
            "units": "imperial",
            "key": key,
        }, timeout=8)
        rows = r.json().get("rows") or []
        el = (rows[0].get("elements") or [{}])[0] if rows else {}
        if el.get("status") == "OK":
            meters = (el.get("distance") or {}).get("value")
            if meters is not None:
                return float(meters) / 1609.344
    except Exception as e:
        logger.warning("[geocoding] distance lookup failed: %s", e)
    return None


def leg_miles(a: Coords, b: Coords, _cache: Optional[dict] = None) -> Tuple[float, bool]:
    """Distance of one drive leg → (miles, estimated). Road distance when the
    Google key works; haversine × ROAD_FACTOR labeled estimated=True otherwise.
    Pass a dict as _cache to dedupe repeated pairs within one report."""
    if _cache is not None:
        hit = _cache.get((a, b)) or _cache.get((b, a))
        if hit is not None:
            return hit
    road = _road_miles(a, b)
    result = (road, False) if road is not None else (haversine_miles(a, b) * ROAD_FACTOR, True)
    if _cache is not None:
        _cache[(a, b)] = result
    return result
