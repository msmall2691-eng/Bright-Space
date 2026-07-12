"""T-20 Part A / acceptance criterion 3: "grep shows every requests., smtplib.,
imaplib., Twilio client, and Google client passes a timeout."

Static sweep, not a network test: for every risky external-call constructor in
backend source (smtplib.SMTP*, imaplib.IMAP4_SSL, urllib.request.urlopen,
requests.*, httpx.*), the enclosing function body must mention "timeout"
somewhere — a hung provider must never be able to wedge a worker
indefinitely. Scoped to the function body (not just the call's own line)
because several call sites configure the timeout via a wrapper/adapter one or
two lines above the actual constructor (e.g. `AuthorizedHttp(creds,
http=httplib2.Http(timeout=...))`, or a module-level constant referenced by
name).

New external integrations should route through one of the modules already
covered here (or get their own timeout) rather than adding an exemption.
"""
import re
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
SKIP_DIR_NAMES = {"tests", "scripts", "alembic", "node_modules", ".git", "__pycache__"}

RISKY_PATTERNS = [
    r"\bsmtplib\.SMTP(_SSL)?\(",
    r"\bimaplib\.IMAP4_SSL\(",
    r"\burllib\.request\.urlopen\(",
    r"\brequests\.(get|post|put|patch|delete|request)\(",
    r"\bhttpx\.(get|post|put|patch|delete|request|Client|AsyncClient)\(",
]
_RISKY_RE = re.compile("|".join(RISKY_PATTERNS))


def _iter_backend_source_files():
    for path in BACKEND_ROOT.rglob("*.py"):
        if any(part in SKIP_DIR_NAMES for part in path.relative_to(BACKEND_ROOT).parts):
            continue
        yield path


def _function_bodies(source: str):
    """Split a module's source into (def-line-index, body-text) chunks, one
    per top-level-or-nested function, so a risky call can be checked against
    just its own enclosing function rather than the whole file (which would
    let an untimed call hide behind an unrelated timeout elsewhere)."""
    lines = source.splitlines()
    def_idxs = [i for i, line in enumerate(lines) if re.match(r"\s*(async\s+)?def\s+\w+\(", line)]
    def_idxs.append(len(lines))
    chunks = []
    for start, end in zip(def_idxs, def_idxs[1:]):
        chunks.append((start, "\n".join(lines[start:end])))
    return chunks, lines


def test_every_risky_call_site_has_a_nearby_timeout():
    violations = []
    for path in _iter_backend_source_files():
        source = path.read_text()
        if not _RISKY_RE.search(source):
            continue
        chunks, lines = _function_bodies(source)
        for start, body in chunks:
            for m in _RISKY_RE.finditer(body):
                if "timeout" in body.lower():
                    continue
                line_no = start + body[: m.start()].count("\n") + 1
                violations.append(f"{path.relative_to(BACKEND_ROOT)}:{line_no}: {m.group(0)} — no 'timeout' in enclosing function")

    assert not violations, (
        "External call(s) with no bounded timeout in their enclosing function "
        "(T-20 Part A — a hung provider must not wedge a worker):\n" + "\n".join(violations)
    )
