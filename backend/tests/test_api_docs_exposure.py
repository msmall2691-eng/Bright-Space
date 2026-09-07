"""BB-SEC-14: the interactive API docs are not for the public internet.

`/docs`, `/redoc` and `/openapi.json` are FastAPI defaults and were served
unauthenticated in production — all 200 to anyone who asked. Nothing there is
a credential, but it is the whole map: every route, every parameter, every
response shape, including admin, payroll and portal endpoints, and it names
routes the UI never links to. It is what you would read first before probing
for a missing role check.

It also quietly turns an endpoint docstring into public documentation, which
is how this was found: BB-SEC-13's writeup landed in the published schema via
`npm run gen:types`, and had to move into a comment.

The gate is environment-shaped rather than role-shaped on purpose. Swagger UI
fetches /openapi.json from the browser as a plain page load, so a dependency
on the route does not give you an authenticated docs page — it gives you a
docs page that renders empty. Off where we deploy, on where we build.

These tests build fresh apps with importlib rather than asserting on the
already-imported `main.app`, because the flag is read once at import.
"""
import importlib
import sys

import pytest
from fastapi.testclient import TestClient

DOC_ROUTES = ("/docs", "/redoc", "/openapi.json")


def _fresh_app(monkeypatch, **env):
    """Re-import main under a given environment and hand back the app."""
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    for mod in ("main",):
        sys.modules.pop(mod, None)
    return importlib.import_module("main")


@pytest.fixture(autouse=True)
def _restore_main():
    """Leave the shared `main` module exactly as we found it — every other test
    file in the suite imports `main.app`, and re-importing swaps the object."""
    saved = sys.modules.get("main")
    yield
    if saved is not None:
        sys.modules["main"] = saved


def test_docs_are_off_when_railway_is_running_us(monkeypatch):
    m = _fresh_app(monkeypatch, RAILWAY_DEPLOYMENT_ID="dep_123", ENABLE_API_DOCS=None)
    assert m.API_DOCS_ENABLED is False

    paths = {r.path for r in m.app.routes}
    for route in DOC_ROUTES:
        assert route not in paths, f"{route} should not be routed in a deploy"

    # NOT asserted as a 404. The SPA catch-all serves index.html for any
    # unrouted path, so these return 200 with the React shell — which is the
    # right outcome and the wrong assertion. What matters is behavioural: no
    # schema, no Swagger UI, whatever the status code.
    client = TestClient(m.app)

    body = client.get("/openapi.json").text
    assert '"openapi"' not in body and '"paths"' not in body, "schema still served"

    assert "swagger" not in client.get("/docs").text.lower(), "Swagger UI still served"
    assert "redoc" not in client.get("/redoc").text.lower(), "ReDoc still served"


def test_docs_are_on_locally(monkeypatch):
    """Off in production must not mean off while building — /docs is genuinely
    useful, and a security fix that makes the tool worse gets reverted."""
    m = _fresh_app(monkeypatch, RAILWAY_DEPLOYMENT_ID=None, ENABLE_API_DOCS=None)
    assert m.API_DOCS_ENABLED is True

    paths = {r.path for r in m.app.routes}
    for route in DOC_ROUTES:
        assert route in paths, route

    # And they serve the real thing, not the SPA shell.
    client = TestClient(m.app)
    schema = client.get("/openapi.json").json()
    assert schema["info"]["title"] == "BrightBase API"
    assert "swagger" in client.get("/docs").text.lower()


def test_the_override_works_in_both_directions(monkeypatch):
    """Turning docs back on in a deploy is one Railway variable and a redeploy
    — no code change, no branch. And they can be turned off locally too."""
    on = _fresh_app(monkeypatch, RAILWAY_DEPLOYMENT_ID="dep_123", ENABLE_API_DOCS="true")
    assert on.API_DOCS_ENABLED is True

    off = _fresh_app(monkeypatch, RAILWAY_DEPLOYMENT_ID=None, ENABLE_API_DOCS="false")
    assert off.API_DOCS_ENABLED is False


def test_the_schema_is_still_generatable_in_process(monkeypatch):
    """`npm run gen:types` imports the app and calls app.openapi() directly, so
    the frontend's generated types must survive the HTTP route being gone. If
    this ever fails, type generation is broken in production builds."""
    m = _fresh_app(monkeypatch, RAILWAY_DEPLOYMENT_ID="dep_123", ENABLE_API_DOCS=None)
    schema = m.app.openapi()
    assert schema["info"]["title"] == "BrightBase API"
    assert "/api/ai/quick" in schema["paths"]
