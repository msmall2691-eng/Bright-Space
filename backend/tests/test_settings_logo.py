"""Company logo upload/serve/delete.

The logo is consumed unauthenticated by the quote email, PDF, and public quote
page, so the bytes must be storable by an admin and servable without a session,
with company_logo_url pointed at our served copy.
"""
import pytest
from unittest.mock import patch

from database.db import SessionLocal
from database.models import AppSetting
from modules.settings.router import (
    upload_company_logo, serve_company_logo, delete_company_logo,
    get_setting, _LOGO_DATA_KEY, _LOGO_MIME_KEY,
)
from fastapi import HTTPException


class _FakeUpload:
    """Minimal stand-in for fastapi UploadFile."""
    def __init__(self, data: bytes, content_type: str):
        self._data = data
        self.content_type = content_type

    async def read(self):
        return self._data


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    for k in (_LOGO_DATA_KEY, _LOGO_MIME_KEY, "company_logo_url"):
        s.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    s.commit(); s.close()


@pytest.mark.asyncio
async def test_upload_then_serve_logo(db):
    png = b"\x89PNG\r\n\x1a\nfakepngbytes"
    with patch("modules.settings.router.app_base_url", return_value="https://app.example.com"):
        out = await upload_company_logo(file=_FakeUpload(png, "image/png"), db=db)
    # company_logo_url points at our served copy, cache-busted with a version.
    assert out["company_logo_url"].startswith("https://app.example.com/api/settings/logo?v=")
    assert get_setting(db, "company_logo_url") == out["company_logo_url"]

    resp = serve_company_logo(db=db)
    assert resp.body == png
    assert resp.media_type == "image/png"


@pytest.mark.asyncio
async def test_reject_non_image(db):
    with pytest.raises(HTTPException) as ei:
        await upload_company_logo(file=_FakeUpload(b"PK\x03\x04", "application/zip"), db=db)
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_reject_oversize(db):
    big = b"x" * (2 * 1024 * 1024 + 1)
    with pytest.raises(HTTPException) as ei:
        await upload_company_logo(file=_FakeUpload(big, "image/png"), db=db)
    assert ei.value.status_code == 400


def test_serve_404_when_unset(db):
    with pytest.raises(HTTPException) as ei:
        serve_company_logo(db=db)
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_clears_logo(db):
    with patch("modules.settings.router.app_base_url", return_value="https://app.example.com"):
        await upload_company_logo(file=_FakeUpload(b"\x89PNGdata", "image/png"), db=db)
    delete_company_logo(db=db)
    assert get_setting(db, "company_logo_url") in (None, "")
    with pytest.raises(HTTPException):
        serve_company_logo(db=db)
