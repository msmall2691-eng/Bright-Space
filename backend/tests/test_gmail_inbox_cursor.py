"""Cursor-based Gmail inbox scan (audit finding #3, July 2026).

fetch_inbox() used to always search "ALL" then slice the last
max_results*3 message ids by IMAP sequence number — a burst of more
messages than that between sync ticks could push a real lead below the
cutoff and it would never be fetched, ever. `since` switches to IMAP's
native SINCE search so the window is time-bounded instead of count-bounded.

get_last_synced_at/set_last_synced_at persist the watermark in AppSetting
so run_inbox_sync can pass it on the next tick.
"""
from datetime import date
from unittest.mock import MagicMock

import integrations.gmail_inbox as inbox
from database.db import SessionLocal
from database.models import AppSetting


def _fake_mail(search_result=("OK", [b""])):
    m = MagicMock()
    m.select = MagicMock(return_value=("OK", []))
    m.search = MagicMock(return_value=search_result)
    m.close = MagicMock()
    m.logout = MagicMock()
    return m


def test_fetch_inbox_defaults_to_all_without_since(monkeypatch):
    m = _fake_mail()
    monkeypatch.setattr(inbox, "_get_credentials",
                        lambda: ("u@example.com", "pw", "imap.example.com", 993, "smtp", 587))
    monkeypatch.setattr(inbox, "_connect", lambda: m)

    inbox.fetch_inbox()
    m.search.assert_called_once_with(None, "ALL")


def test_fetch_inbox_uses_since_as_native_imap_search(monkeypatch):
    m = _fake_mail()
    monkeypatch.setattr(inbox, "_get_credentials",
                        lambda: ("u@example.com", "pw", "imap.example.com", 993, "smtp", 587))
    monkeypatch.setattr(inbox, "_connect", lambda: m)

    inbox.fetch_inbox(since="2026-07-01")
    m.search.assert_called_once_with(None, '(SINCE "01-Jul-2026")')


def test_fetch_inbox_falls_back_to_all_on_bad_since(monkeypatch):
    m = _fake_mail()
    monkeypatch.setattr(inbox, "_get_credentials",
                        lambda: ("u@example.com", "pw", "imap.example.com", 993, "smtp", 587))
    monkeypatch.setattr(inbox, "_connect", lambda: m)

    inbox.fetch_inbox(since="not-a-date")
    m.search.assert_called_once_with(None, "ALL")


def test_run_inbox_sync_advances_cursor_on_imap_path(monkeypatch):
    """emails=None means run_inbox_sync did its own IMAP fetch — it owns
    reading the cursor going in and advancing it after a successful commit."""
    import modules.gmail.router as gmail_router

    calls = {}

    def _fake_fetch(**kw):
        calls["fetch_kwargs"] = kw
        return []
    monkeypatch.setattr(gmail_router, "fetch_inbox", _fake_fetch)
    monkeypatch.setattr(inbox, "get_last_synced_at", lambda: "2026-07-01")
    monkeypatch.setattr(inbox, "set_last_synced_at", lambda v: calls.setdefault("set_value", v))

    db = SessionLocal()
    try:
        gmail_router.run_inbox_sync(db)
    finally:
        db.close()

    assert calls["fetch_kwargs"]["since"] == "2026-07-01"
    assert "set_value" in calls


def test_run_inbox_sync_does_not_advance_cursor_when_emails_supplied(monkeypatch):
    """Callers that pass their own `emails` (tests, the per-account Gmail-API
    path, a one-off manual re-sync) must not move the shared-inbox
    watermark — they didn't do the IMAP fetch this cursor tracks."""
    import modules.gmail.router as gmail_router

    called = {"set": False}
    monkeypatch.setattr(inbox, "set_last_synced_at", lambda v: called.__setitem__("set", True))

    db = SessionLocal()
    try:
        gmail_router.run_inbox_sync(db, emails=[])
    finally:
        db.close()

    assert called["set"] is False


def test_last_synced_at_roundtrip():
    db = SessionLocal()
    try:
        db.query(AppSetting).filter(AppSetting.key == inbox.LAST_SYNCED_SETTING_KEY).delete()
        db.commit()

        assert inbox.get_last_synced_at() is None

        inbox.set_last_synced_at("2026-07-10")
        assert inbox.get_last_synced_at() == "2026-07-10"

        # Overwrite, not duplicate.
        inbox.set_last_synced_at("2026-07-11")
        assert inbox.get_last_synced_at() == "2026-07-11"
        assert db.query(AppSetting).filter(
            AppSetting.key == inbox.LAST_SYNCED_SETTING_KEY
        ).count() == 1
    finally:
        db.query(AppSetting).filter(AppSetting.key == inbox.LAST_SYNCED_SETTING_KEY).delete()
        db.commit()
        db.close()
