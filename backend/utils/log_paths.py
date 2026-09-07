"""BB-SEC-15: never write a capability URL into the log stream.

Fourteen public routes carry their credential IN THE PATH:

    /api/quotes/public/{token}          and 7 more under it
    /api/jobs/public/{token}            and 5 more under it

There is no session behind them by design — the customer clicks a link in an
email or text and the token *is* the authorisation. Holding the path is
holding the ability to read a quote, accept it on the customer's behalf,
decline it, see a property photo, or reschedule a job.

The request logger logged `request.url.path` at INFO on every request, so
every one of those tokens went to stdout, which Railway captures and retains
under different access rules from the database — and for longer than the token
stays valid. Anyone who can read deploy logs could act as any customer who
clicked a link.

The fix is not to stop logging. It is to log the ROUTE TEMPLATE that Starlette
already matched — `/api/quotes/public/{token}` rather than
`/api/quotes/public/9f3a…` — which is both safe and more useful: log lines now
group by endpoint instead of scattering one line per token.

Query strings were never logged (`.path` excludes them) and still are not.
"""
from __future__ import annotations

import re

# A path segment nothing routed to. Long and not a plain id → assume it is a
# secret. Deliberately eager: an over-redacted 404 costs a little diagnostic
# detail, an under-redacted one writes a live credential to disk.
_LONG_OPAQUE = re.compile(r"^[A-Za-z0-9_\-.:%]{16,}$")

REDACTED = "{redacted}"


def redact_unmatched(path: str) -> str:
    """Scrub a path that matched no route.

    A 404 still reaches the logger, and a mistyped or expired capability URL is
    exactly the shape that 404s — so the raw path cannot be trusted here just
    because routing rejected it.
    """
    parts = path.split("/")
    out = []
    for p in parts:
        if not p or p.isdigit() or len(p) < 16:
            out.append(p)
        elif _LONG_OPAQUE.match(p):
            out.append(REDACTED)
        else:
            out.append(p)
    return "/".join(out)


def _template_from_params(scope) -> Optional[str]:
    """Rebuild the route template by replacing each matched path-param VALUE in
    the real path with its `{name}`.

    `scope["path"]` is the full path the request actually hit, values and all;
    `scope["path_params"]` maps each param name to the value the router bound.
    Substituting values for `{name}` reproduces `/api/quotes/public/{token}`
    from `/api/quotes/public/9f3a…` — the full path, no values.

    This is preferred over reading `scope["route"].path` because that changed
    between Starlette versions: <0.40 it was the FULL template, but 1.x returns
    the template RELATIVE to the router mount (`/public/{token}`), dropping the
    `/api/quotes` prefix. Rebuilding from the real path is stable across both,
    and still parameter-NAMES-only, so no token or id can leak whatever the
    framework does with route objects.
    """
    path = scope.get("path")
    params = scope.get("path_params")
    if not path or not params:
        return None
    # Segment-wise, so a value that also appears as a literal elsewhere in the
    # path is not blanked by accident. A `:path` converter value can itself
    # contain slashes, so also try a whole-string replace as a fallback.
    segments = path.split("/")
    values = {str(v): "{%s}" % k for k, v in params.items() if v not in (None, "")}
    out = [values.get(seg, seg) for seg in segments]
    rebuilt = "/".join(out)
    if rebuilt == path:
        # Nothing matched segment-wise (e.g. a path-converter value with
        # slashes). Fall back to replacing each value wherever it appears.
        for val, name in values.items():
            rebuilt = rebuilt.replace(val, name)
    return rebuilt


def loggable_path(request) -> str:
    """The path as it should appear in a log line: the full route template, with
    every path parameter as its `{name}` rather than its value, so no token or
    id can reach the log — and it holds for routes that do not exist yet,
    without anyone remembering to add them to a list.
    """
    try:
        scope = request.scope
        rebuilt = _template_from_params(scope)
        if rebuilt:
            return rebuilt
        # No path params bound → either a static route (safe to log as-is) or an
        # unmatched path (redact the long opaque segments defensively).
        raw = scope.get("path") or request.url.path
        route = scope.get("route")
        if route is not None:
            return raw           # matched a param-less route: nothing to hide
        return redact_unmatched(raw)
    except Exception:
        # Instrumentation must never break a response, and a logger that
        # cannot determine a safe path logs nothing identifying at all.
        return REDACTED
