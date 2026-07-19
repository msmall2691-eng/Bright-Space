"""delete_shift must be idempotent: a 404 (shift already gone in Connecteam)
is success, not an error. Otherwise re-pushing a job whose shift was deleted in
Connecteam leaves the stale id in place and auto_dispatch skips it — the
"Re-send to Connecteam" flow reports success but pushes nothing (Codex P2).
"""
import asyncio

import pytest

import integrations.connecteam as ct


class _Resp:
    def __init__(self, code):
        self.status_code = code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeClient:
    def __init__(self, code):
        self._code = code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def delete(self, *a, **k):
        return _Resp(self._code)


@pytest.fixture(autouse=True)
def _stub_conn(monkeypatch):
    monkeypatch.setattr(ct, "_get_scheduler_id", lambda: "1")
    monkeypatch.setattr(ct, "_get_api_key", lambda: "test-key")


def test_delete_shift_swallows_404(monkeypatch):
    monkeypatch.setattr(ct.httpx, "AsyncClient", lambda *a, **k: _FakeClient(404))
    # Must NOT raise — the shift is already gone, which is what we wanted.
    asyncio.run(ct.delete_shift("already-gone"))


def test_delete_shift_still_raises_on_real_failure(monkeypatch):
    monkeypatch.setattr(ct.httpx, "AsyncClient", lambda *a, **k: _FakeClient(500))
    with pytest.raises(Exception):
        asyncio.run(ct.delete_shift("boom"))
