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


def loggable_path(request) -> str:
    """The path as it should appear in a log line.

    Prefers the matched route's template, which contains parameter NAMES rather
    than values, so no path parameter — token, id, or anything added later —
    can reach the log. That is the property worth having: it holds for routes
    that do not exist yet, without anyone remembering to add them to a list.
    """
    try:
        route = request.scope.get("route")
        template = getattr(route, "path", None)
        if template:
            return template
        return redact_unmatched(request.url.path)
    except Exception:
        # Instrumentation must never break a response, and a logger that
        # cannot determine a safe path logs nothing identifying at all.
        return REDACTED
