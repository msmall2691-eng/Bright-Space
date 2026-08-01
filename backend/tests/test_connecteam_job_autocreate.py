"""Auto-create a Connecteam Job when a job's client/property has no matching
Job yet — so booking a brand-new client/property lands under its own Job in
Connecteam's Jobs list instead of a blank free-text open shift.

Hermetic: no network — the create call, settings gate, and DB lookups are all
monkeypatched / faked.
"""
from types import SimpleNamespace

import pytest

import integrations.connecteam as ct
import integrations.connecteam_auto as ca


# ---- response parsing -----------------------------------------------------

@pytest.mark.parametrize("payload,expected", [
    ({"data": {"job": {"jobId": 42}}}, "42"),
    ({"data": {"jobs": [{"jobId": 7}]}}, "7"),
    ({"data": {"jobs": [{"id": 9}]}}, "9"),
    ({"jobId": 5}, "5"),
    ({"data": {"jobs": []}}, None),
    ({"data": {}}, None),
])
def test_extract_created_job_id_shapes(payload, expected):
    assert ct._extract_created_job_id(payload) == expected


# ---- cache indexing -------------------------------------------------------

def test_index_job_fills_gap_without_clobbering():
    ct._JOBS_CACHE["by_norm"] = {"pier house": "EXISTING"}
    ct._index_job("Pier House", "NEW")          # name already mapped → keep old
    ct._index_job("Lake House #2", "LAKE1")     # new normalized key → added
    assert ct._JOBS_CACHE["by_norm"]["pier house"] == "EXISTING"
    assert ct._JOBS_CACHE["by_norm"]["lake house 2"] == "LAKE1"


# ---- create_job payload ---------------------------------------------------

def test_create_job_posts_array_with_name_and_scheduler_instance(monkeypatch):
    monkeypatch.setattr(ct, "_get_scheduler_id", lambda: "9454799")
    monkeypatch.setattr(ct, "_get_api_key", lambda: "k")
    sent = {}

    class _Resp:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"data": {"jobs": [{"jobId": "J_NEW"}]}}

    class _Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, headers=None, json=None):
            sent["url"] = url
            sent["body"] = json
            return _Resp()

    monkeypatch.setattr(ct.httpx, "AsyncClient", _Client)
    new_id = ct._run_sync(ct.create_job("Lake House", address="9 Lakeview Rd"))
    assert new_id == "J_NEW"
    assert sent["url"].endswith("/jobs/v1/jobs")
    assert isinstance(sent["body"], list)                       # array body
    job = sent["body"][0]
    assert job["name"] == "Lake House"
    assert job["assignedInstanceIds"] == [9454799]              # scheduler, as int
    assert job["gps"]["address"] == "9 Lakeview Rd"


# ---- dispatch wiring ------------------------------------------------------

class _Query:
    def __init__(self, row): self._row = row
    def filter(self, *a, **k): return self
    def first(self): return self._row


class FakeDB:
    """Returns a Property for the first query, a Client for the second."""
    dirty = ()
    def __init__(self, prop=None, client=None):
        self._rows = [prop, client]
    def query(self, _model):
        return _Query(self._rows.pop(0) if self._rows else None)
    def commit(self): pass
    def refresh(self, _o, with_for_update=False): pass


def _job(**over):
    base = dict(id=1, status="scheduled", title="Clean — Lake House",
                job_type="str_turnover", scheduled_date="2026-06-20",
                start_time="10:00", end_time="13:00", address="9 Lakeview Rd",
                notes=None, cleaner_ids=[], connecteam_shift_ids=[], dispatched=False,
                property_id=7, client_id=3)
    base.update(over)
    return SimpleNamespace(**base)


def test_unmatched_job_creates_connecteam_job_when_enabled(monkeypatch):
    monkeypatch.setattr(ct, "resolve_job_id", lambda cands: None)   # no match
    monkeypatch.setattr(ca, "_auto_create_jobs_enabled", lambda db: True)
    created = {}
    def _fake_create(name, address=None):
        created["name"] = name
        created["address"] = address
        return "J_CREATED"
    monkeypatch.setattr(ct, "create_job_sync", _fake_create)
    monkeypatch.setattr(ct, "_index_job", lambda name, jid: None)

    db = FakeDB(prop=SimpleNamespace(name="Lake House"),
                client=SimpleNamespace(name="Jane Lake"))
    assert ca._ct_job_id_for(db, _job()) == "J_CREATED"
    assert created["name"] == "Lake House"          # property name preferred
    assert created["address"] == "9 Lakeview Rd"    # job address carried over


def test_unmatched_job_does_not_create_when_disabled(monkeypatch):
    monkeypatch.setattr(ct, "resolve_job_id", lambda cands: None)
    monkeypatch.setattr(ca, "_auto_create_jobs_enabled", lambda db: False)
    monkeypatch.setattr(ct, "create_job_sync",
                        lambda *a, **k: pytest.fail("must not create when disabled"))

    db = FakeDB(prop=SimpleNamespace(name="Lake House"), client=None)
    assert ca._ct_job_id_for(db, _job()) is None


def test_matched_job_short_circuits_before_create(monkeypatch):
    monkeypatch.setattr(ct, "resolve_job_id", lambda cands: "J_MATCH")
    monkeypatch.setattr(ct, "create_job_sync",
                        lambda *a, **k: pytest.fail("must not create when matched"))
    db = FakeDB(prop=SimpleNamespace(name="Lake House"), client=None)
    assert ca._ct_job_id_for(db, _job()) == "J_MATCH"
