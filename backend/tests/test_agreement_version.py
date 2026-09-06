"""Correcting a signed document means a NEW version, never an edit.

Section 7 of the 2026-09 agreement stated the 1099-NEC threshold as $600. The
One Big Beautiful Bill Act raised it to $2,000 for payments made after 31 Dec
2025, so the figure was wrong for the first year the document covers.

Every acceptance records a SHA-256 of the exact bytes shown (migration 105).
Editing 2026-09 in place would leave any past acceptance pointing at a hash
that no longer matches anything — precisely the failure that hash exists to
catch. So the fix is a new version, and what is pinned here is that the old
text stays exactly as it was.
"""
import re

from services.sub_agreement import current, load
from services.sub_vetting import CURRENT_AGREEMENT_VERSION


def test_the_current_version_is_the_corrected_one():
    assert CURRENT_AGREEMENT_VERSION == "2026-10"
    assert current()["version"] == "2026-10"


def test_the_old_version_is_untouched_and_still_loads():
    """A sub who accepted 2026-09 must still be able to prove what they signed."""
    text, digest = load("2026-09")
    assert "$600 or more" in text, "the superseded text was edited in place"
    assert len(digest) == 64


def test_the_two_versions_are_different_documents():
    _, old = load("2026-09")
    new = current()
    assert new["sha256"] != old, "a corrected document with an unchanged hash"


def test_section_7_no_longer_states_a_bare_600():
    text = current()["text"]
    section = re.search(r"## 7\. Taxes(.*?)## 8\.", text, re.S)
    assert section, "section 7 not found"
    body = section.group(1)
    assert "$2,000" in body
    assert "$600 or more" not in body
    # The threshold is indexed after 2026 and states differ, so the text says
    # "the amount the IRS sets" rather than pinning one number forever.
    assert "the IRS sets for that year" in body


def test_the_agreement_still_ships_in_the_image():
    """Both files, so an old acceptance can be re-rendered from the container."""
    from services.sub_agreement import AGREEMENTS_DIR
    names = {p.name for p in AGREEMENTS_DIR.glob("subcontractor_*.md")}
    assert {"subcontractor_2026-09.md", "subcontractor_2026-10.md"} <= names
