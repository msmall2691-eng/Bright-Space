"""Live-run #2 finding: inbound website leads were lost because CORS could drop
the maineclean.co origin if ALLOWED_ORIGINS was set but incomplete in the env.

resolve_cors_origins force-merges the required production origins so a partial
override can't break the lead pipeline.
"""
from config import resolve_cors_origins, REQUIRED_CORS_ORIGINS


def test_required_origins_present_when_env_unset():
    origins = resolve_cors_origins(None)
    for o in REQUIRED_CORS_ORIGINS:
        assert o in origins


def test_partial_override_still_includes_website():
    # An env that forgot maineclean.co (the exact lost-leads scenario).
    origins = resolve_cors_origins("https://brightbase-production.up.railway.app")
    assert "https://maineclean.co" in origins
    assert "https://www.maineclean.co" in origins
    assert "https://brightbase-production.up.railway.app" in origins


def test_no_duplicates_when_override_already_has_them():
    origins = resolve_cors_origins("https://maineclean.co,https://maineclean.co")
    assert origins.count("https://maineclean.co") == 1


def test_empty_string_falls_back_to_defaults():
    origins = resolve_cors_origins("   ")
    assert "https://maineclean.co" in origins
    assert "http://localhost:5173" in origins


def test_app_subdomain_is_required():
    """app.maineclean.co is where the SPA itself is served from since the
    custom-domain switch. Same-origin calls need no CORS, but a browser on the
    app host talking to the Railway host (true during the cutover, and for any
    link still pointing at the old domain) does — so a partial ALLOWED_ORIGINS
    override must not be able to drop it either."""
    origins = resolve_cors_origins("https://example.test")
    assert "https://app.maineclean.co" in origins
