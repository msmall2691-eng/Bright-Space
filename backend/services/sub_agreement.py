"""The subcontractor agreement itself — the text, and proof of which text.

WHY THIS EXISTS. `CURRENT_AGREEMENT_VERSION` was a bare string, and the accept
endpoint recorded that somebody had tapped a button. There was no document
anywhere in the repo, no endpoint serving one, and no screen rendering one. Subs
were signing a version number.

That is not a small gap. The whole subcontractor arrangement rests on Maine's
employment standard, and "the parties have a contract that defines the
relationship" is one of the criteria it counts — one of the few this business
can satisfy outright, and it was the one being asserted with nothing behind it.

WHAT THIS ADDS. The text lives in `backend/agreements/` as a versioned Markdown
file, and every acceptance records a **SHA-256 of the exact bytes shown**. The
version string alone was never enough: a typo fixed without bumping the version
would silently change what past acceptances appear to mean. A hash cannot.

Read once and cached. The file does not change between deploys, and a sub's
phone should not pay for a disk read (see brightbase-economy).
"""
from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path

AGREEMENTS_DIR = Path(__file__).resolve().parent.parent / "agreements"


class AgreementMissing(RuntimeError):
    """The versioned text is not on disk.

    Raised rather than falling back to an empty string or a placeholder: a
    signature against nothing is exactly the state this module exists to end,
    and it should fail loudly at the point of use.
    """


@lru_cache(maxsize=8)
def load(version: str) -> tuple[str, str]:
    """Return (text, sha256) for a version. Cached; the file is immutable."""
    path = AGREEMENTS_DIR / f"subcontractor_{version}.md"
    try:
        raw = path.read_bytes()
    except FileNotFoundError as e:
        raise AgreementMissing(
            f"No agreement text for version {version!r} at {path}. "
            "A version with no document behind it cannot be signed."
        ) from e
    return raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()


def current() -> dict:
    """The version a sub is asked to accept today, with its text and hash."""
    from services.sub_vetting import CURRENT_AGREEMENT_VERSION

    text, digest = load(CURRENT_AGREEMENT_VERSION)
    return {"version": CURRENT_AGREEMENT_VERSION, "text": text, "sha256": digest}
