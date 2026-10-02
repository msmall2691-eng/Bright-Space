"""utils.uploads.read_capped — reject an oversized upload without buffering it.

FastAPI's UploadFile.read() buffers the whole body before a size check the
handler runs afterward. read_capped reads in chunks and 413s the moment the
running total crosses the cap, so the buffer never holds more than the cap plus
one chunk. Pinned here so the crew upload sites keep that behaviour.
"""
import asyncio

import pytest
from fastapi import HTTPException

from utils.uploads import read_capped


class _FakeUpload:
    """Minimal stand-in for starlette's UploadFile — hands back the data in
    read(n) slices, and records how many bytes were ever pulled."""
    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0
        self.pulled = 0

    async def read(self, n: int = -1) -> bytes:
        if self._pos >= len(self._data):
            return b""
        end = len(self._data) if n is None or n < 0 else min(self._pos + n, len(self._data))
        chunk = self._data[self._pos:end]
        self._pos = end
        self.pulled += len(chunk)
        return chunk


def test_under_the_cap_returns_all_bytes():
    f = _FakeUpload(b"x" * 1000)
    data = asyncio.run(read_capped(f, 2000, detail="too big"))
    assert data == b"x" * 1000


def test_over_the_cap_raises_413():
    f = _FakeUpload(b"x" * (300 * 1024))            # 300 KB
    with pytest.raises(HTTPException) as ei:
        asyncio.run(read_capped(f, 100 * 1024, detail="Photo too large (5MB max)."))
    assert ei.value.status_code == 413
    assert ei.value.detail == "Photo too large (5MB max)."


def test_aborts_early_without_reading_the_whole_file():
    # 10 MB body, 100 KB cap: read_capped must bail out long before pulling it
    # all — that's the whole point (no full buffer of an oversized upload).
    f = _FakeUpload(b"x" * (10 * 1024 * 1024))
    with pytest.raises(HTTPException):
        asyncio.run(read_capped(f, 100 * 1024, detail="too big"))
    assert f.pulled < 300 * 1024, f"pulled {f.pulled} bytes — should stop near the cap"


def test_empty_upload_returns_empty_bytes():
    # read_capped doesn't judge emptiness — callers keep their own empty check.
    f = _FakeUpload(b"")
    assert asyncio.run(read_capped(f, 1000, detail="too big")) == b""
