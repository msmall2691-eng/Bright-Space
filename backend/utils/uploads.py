"""Read an upload without buffering an oversized file.

FastAPI's ``UploadFile.read()`` pulls the whole body into its spooled buffer
before any size check the handler runs afterward — so a client could stream a
file far past the limit and the server buffers all of it before returning 413.
``read_capped`` reads in chunks and raises 413 the moment the running total
crosses ``max_bytes``, so the buffer never holds more than the cap plus one
chunk. Drop-in for ``await file.read()`` at the upload sites.
"""
from fastapi import HTTPException, UploadFile

_CHUNK = 64 * 1024


async def read_capped(file: UploadFile, max_bytes: int, *, detail: str) -> bytes:
    """Read ``file`` fully, but abort with 413 as soon as it exceeds
    ``max_bytes``. Returns the bytes (which may be empty — callers that reject
    empty uploads still do their own check)."""
    buf = bytearray()
    while True:
        chunk = await file.read(_CHUNK)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > max_bytes:
            raise HTTPException(status_code=413, detail=detail)
    return bytes(buf)
