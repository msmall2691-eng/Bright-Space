"""Audit #4 Upgrade 2B: Google Calendar push-channel (events.watch) handler.

The public notification endpoint is authenticated by the per-channel token, not
the API key. These pin: a valid notification triggers an incremental sync for the
right calendar; a bad/unknown token does nothing; the initial 'sync' handshake is
acked without syncing.
"""
from unittest.mock import patch

from database.db import SessionLocal
from database.models import AppSetting
from integrations import gcal_watch

CAL = "watch-cal-1"
CHANNEL = "bb-test-channel"
TOKEN = "secret-token-xyz"


def _seed_watch(db):
    gcal_watch._put(db, CAL, {"channel_id": CHANNEL, "resource_id": "res-1",
                              "token": TOKEN, "expiration_ms": 9999999999999})
    db.commit()


def _clear(db):
    db.query(AppSetting).filter(AppSetting.key == gcal_watch._key(CAL)).delete(synchronize_session=False)
    db.commit()


def test_valid_notification_triggers_incremental_sync():
    db = SessionLocal()
    _seed_watch(db)
    try:
        with patch("integrations.gcal_sync.sync_calendar") as mock_sync:
            out = gcal_watch.handle_notification(db, {
                "x-goog-channel-id": CHANNEL,
                "x-goog-channel-token": TOKEN,
                "x-goog-resource-state": "exists",
            })
        assert out["ok"] is True and out["synced"] is True and out["calendar"] == CAL
        mock_sync.assert_called_once()
        # synced exactly the matched calendar
        assert mock_sync.call_args.kwargs.get("calendar_ids") == [CAL]
    finally:
        _clear(db); db.close()


def test_bad_token_does_not_sync():
    db = SessionLocal()
    _seed_watch(db)
    try:
        with patch("integrations.gcal_sync.sync_calendar") as mock_sync:
            out = gcal_watch.handle_notification(db, {
                "x-goog-channel-id": CHANNEL,
                "x-goog-channel-token": "WRONG",
                "x-goog-resource-state": "exists",
            })
        assert out["ok"] is False
        mock_sync.assert_not_called()
    finally:
        _clear(db); db.close()


def test_sync_handshake_is_acked_without_syncing():
    db = SessionLocal()
    _seed_watch(db)
    try:
        with patch("integrations.gcal_sync.sync_calendar") as mock_sync:
            out = gcal_watch.handle_notification(db, {
                "x-goog-channel-id": CHANNEL,
                "x-goog-channel-token": TOKEN,
                "x-goog-resource-state": "sync",
            })
        assert out["ok"] is True and out["synced"] is False
        mock_sync.assert_not_called()
    finally:
        _clear(db); db.close()
