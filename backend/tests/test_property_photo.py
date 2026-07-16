"""Staff-facing property photo endpoint.

The customer sees a Street View photo on their quote; staff should see the same
photo (by address) on the Requests drawer and the quote composer, before a quote
exists. The endpoint is auth-gated and 404s cleanly when photos are off or
Google has no imagery, so the UI just hides the image.
"""
from unittest.mock import patch

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_property_photo_404_when_disabled():
    # Default test env has no google_maps_api_key / property_photo_enabled.
    r = client.get("/api/quotes/property-photo", params={"address": "4 Balsam Drive, Waterboro, ME 04061"})
    assert r.status_code == 404


def test_property_photo_streams_jpeg_when_available():
    with patch("services.property_media.street_view_enabled", return_value=True), \
         patch("services.property_media.street_view_bytes", return_value=b"\xff\xd8\xff\xe0JPEGDATA"):
        r = client.get("/api/quotes/property-photo", params={"address": "4 Balsam Drive, Waterboro, ME 04061"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == b"\xff\xd8\xff\xe0JPEGDATA"


def test_property_photo_404_when_google_has_no_imagery():
    with patch("services.property_media.street_view_enabled", return_value=True), \
         patch("services.property_media.street_view_bytes", return_value=None):
        r = client.get("/api/quotes/property-photo", params={"address": "nowhere"})
    assert r.status_code == 404
