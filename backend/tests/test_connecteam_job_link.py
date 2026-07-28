"""Pushed Connecteam shifts link to the account's Job entity (one Job per
client/property), matched by name — so a shift shows the customer/property and
lands under the right Job, not as a blank free-text open shift. Linking is
best-effort: if the matched job id is bad, the push retries UNLINKED so the
shift still lands.

Hermetic: no network — the Jobs index and the create calls are monkeypatched.
"""
from types import SimpleNamespace

import pytest

import integrations.connecteam as ct
import integrations.connecteam_auto as ca


# ---- payload shape --------------------------------------------------------

def test_shift_payload_links_job_top_level_and_inherits_location():
    p = ct._shift_payload(
        start_datetime="2026-06-20T10:00:00", end_datetime="2026-06-20T13:00:00",
        title="Turnover — Pier House", address="1 Ocean Ave",
        open_shift=True, is_published=False, job_id="JOB123",
    )
    assert p["jobId"] == "JOB123"                       # top-level
    assert p["locationData"] == {"isReferencedToJob": True}  # inherit job location
    assert "address" not in p["locationData"]           # not free-text when linked
    assert p["isOpenShift"] is True and p["assignedUserIds"] == []
    assert p["isPublished"] is False                    # draft


def test_shift_payload_without_job_stays_free_text():
    p = ct._shift_payload(
        start_datetime="2026-06-20T10:00:00", end_datetime="2026-06-20T13:00:00",
        title="Turnover", address="1 Ocean Ave", open_shift=True,
    )
    assert "jobId" not in p
    assert p["locationData"] == {"address": "1 Ocean Ave", "isReferencedToJob": False}


# ---- name matching --------------------------------------------------------

def test_resolve_job_id_exact_and_containment(monkeypatch):
    monkeypatch.setattr(ct, "_jobs_index",
                        lambda force=False: {"pier house": "J1", "smith residence": "J2"})
    assert ct.resolve_job_id(["Pier House"]) == "J1"          # exact (normalized)
    assert ct.resolve_job_id(["Pier House Cottage"]) == "J1"  # containment
    assert ct.resolve_job_id(["Smith Residence"]) == "J2"
    assert ct.resolve_job_id(["Unknown Place"]) is None
    assert ct.resolve_job_id([]) is None


def test_resolve_job_id_is_property_first_across_match_types(monkeypatch):
    """A property CONTAINMENT match must beat a client EXACT match — the
    property candidate (passed first) is fully resolved before the client."""
    monkeypatch.setattr(ct, "_jobs_index",
                        lambda force=False: {"pier house": "J1", "smith residence": "J2"})
    # property 'Pier House Cottage' (containment→J1) vs client 'Smith Residence' (exact→J2)
    assert ct.resolve_job_id(["Pier House Cottage", "Smith Residence"]) == "J1"


# ---- dispatch wiring ------------------------------------------------------

class FakeDB:
    dirty = ()
    def commit(self): pass
    def refresh(self, _o, with_for_update=False): pass


def _job(**over):
    base = dict(id=1, status="scheduled", title="Turnover — Pier House",
                job_type="str_turnover", scheduled_date="2026-06-20",
                start_time="10:00", end_time="13:00", address="1 Ocean Ave",
                notes=None, cleaner_ids=[], connecteam_shift_ids=[], dispatched=False,
                property_id=7, client_id=3)
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def _quiet_log(monkeypatch):
    monkeypatch.setattr(ca, "_log", lambda *a, **k: None)


def test_turnover_shift_is_pushed_linked_to_the_matched_job(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "_ct_job_id_for", lambda db, job: "JOB_PIER")
    calls = []
    monkeypatch.setattr(ca, "create_open_shift_sync",
                        lambda **kw: (calls.append(kw), {"id": "s1"})[1])

    out = ca.auto_dispatch_job(FakeDB(), _job())
    assert out["dispatched"] is True
    assert calls[0]["job_id"] == "JOB_PIER"     # linked
    assert calls[0]["is_published"] is False    # draft


class _Resp:
    def __init__(self, code): self.status_code = code


class _HttpErr(Exception):
    """Stand-in for httpx.HTTPStatusError — carries a .response.status_code."""
    def __init__(self, code): self.response = _Resp(code)


def test_rejected_job_link_falls_back_to_unlinked_shift(monkeypatch):
    """A DEFINITIVE rejection (HTTP 400) of the jobId → retry unlinked so the
    shift still lands."""
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "_ct_job_id_for", lambda db, job: "JOB_BAD")

    def flaky(**kw):
        if kw.get("job_id"):
            raise _HttpErr(400)     # Connecteam refused the jobId — created nothing
        return {"id": "s2"}
    monkeypatch.setattr(ca, "create_open_shift_sync", flaky)

    job = _job()
    out = ca.auto_dispatch_job(FakeDB(), job)
    assert out["dispatched"] is True               # shift still landed
    assert job.connecteam_shift_ids == ["s2"]      # via the unlinked fallback


def test_ambiguous_failure_does_not_retry(monkeypatch):
    """A timeout / 5xx (no definitive rejection) must NOT trigger a second
    create — the linked shift may have been made, and a retry would duplicate it."""
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "_ct_job_id_for", lambda db, job: "JOB_X")

    calls = []
    def flaky(**kw):
        calls.append(kw)
        raise TimeoutError("read timeout")   # ambiguous — no .response
    monkeypatch.setattr(ca, "create_open_shift_sync", flaky)

    job = _job()
    out = ca.auto_dispatch_job(FakeDB(), job)
    assert out["dispatched"] is False              # nothing recorded
    assert len(calls) == 1                          # only the linked attempt; no retry
    assert job.connecteam_shift_ids in ([], None)
