"""The public legal pages must be REAL, no-JS HTML — not the SPA shell.

maineclean.co served the same JavaScript-only shell for every route, so
/privacy, /terms and /sms returned HTTP 200 with only the homepage <title> and
no policy text. A carrier's A2P/10DLC reviewer fetches the declared privacy URL
without running JavaScript; an empty-but-200 page is a campaign-rejection reason
that would block all outbound SMS. These tests pin that the pages now carry
actual policy content and the 10DLC essentials, server-side.
"""
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_privacy_serves_real_policy_without_js():
    r = client.get("/privacy")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    body = r.text
    assert "Privacy Policy" in body
    # The substance a reviewer/crawler must be able to see with no JS:
    assert "do not sell" in body.lower()
    assert "Twilio" in body and "Square" in body
    # Not the SPA shell (which only carried the marketing homepage title).
    assert "Airbnb Cleaning &amp; STR Management" not in body
    assert '<div id="root"></div>' not in body


def test_terms_serves_real_content():
    r = client.get("/terms")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "Terms of Service" in r.text
    assert "Maine" in r.text  # governing-law section


def test_sms_page_has_the_10dlc_essentials():
    r = client.get("/sms")
    assert r.status_code == 200
    body = r.text
    assert "SMS Terms" in body
    # A2P/10DLC reviewers look for exactly these.
    assert "Message and data rates may apply" in body
    assert "STOP" in body and "HELP" in body
    assert "opt out" in body.lower()
    # Must state the number/opt-in isn't shared for marketing.
    assert "do not sell or share your mobile number" in body.lower()


def test_pages_are_indexable_and_cross_link():
    for path in ("/privacy", "/terms", "/sms"):
        body = client.get(path).text
        assert 'name="robots" content="index, follow"' in body
        # Each page links to the other two (crawl discovery + reviewer nav).
        assert 'href="/privacy"' in body
        assert 'href="/terms"' in body
        assert 'href="/sms"' in body
