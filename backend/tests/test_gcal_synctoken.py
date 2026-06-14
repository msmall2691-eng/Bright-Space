"""Audit #4 Upgrade 2 (A): incremental Google Calendar sync via syncToken.

After a first bounded full list, sync_calendar stores Google's nextSyncToken and
uses it for subsequent polls (only changed events come back — cheap, no misses).
An expired token (HTTP 410) drops the cursor and falls back to a full resync.
"""
from unittest.mock import patch, MagicMock

from database.db import SessionLocal
from integrations import gcal_sync
from integrations.gcal_sync import _get_synctoken, _save_synctoken

CAL = "primary"


def _service(items, next_token=None, gone_on_token=False):
    """Fake Google service that records list() params and can 410 on a syncToken."""
    svc = MagicMock()
    calls = {"params": []}

    def _list(**params):
        calls["params"].append(params)
        ex = MagicMock()
        if gone_on_token and "syncToken" in params:
            class _Resp:  # mimic googleapiclient's HttpError.resp
                status = 410
            err = Exception("410 gone")
            err.resp = _Resp()
            ex.execute.side_effect = err
        else:
            ex.execute.return_value = {"items": items, "nextSyncToken": next_token}
        return ex

    svc.events.return_value.list.side_effect = _list
    return svc, calls


def _run(db, svc):
    with patch("integrations.google_calendar._get_service", return_value=svc), \
         patch("integrations.gcal_sync.calendar_source_of_truth", return_value="brightbase"):
        return gcal_sync.sync_calendar(db, calendar_ids=[CAL])


def test_synctoken_saved_then_reused_incrementally():
    db = SessionLocal()
    try:
        _save_synctoken(db, CAL, None); db.commit()           # start clean

        svc1, calls1 = _service([], next_token="TOK1")
        _run(db, svc1)
        # First poll is a bounded FULL list (no syncToken), and the cursor persists.
        assert "syncToken" not in calls1["params"][0]
        assert calls1["params"][0].get("timeMin")
        assert _get_synctoken(db, CAL) == "TOK1"

        svc2, calls2 = _service([], next_token="TOK2")
        _run(db, svc2)
        # Second poll is INCREMENTAL: uses the stored token, no time window.
        assert calls2["params"][0].get("syncToken") == "TOK1"
        assert "timeMin" not in calls2["params"][0]
        assert _get_synctoken(db, CAL) == "TOK2"
    finally:
        _save_synctoken(db, CAL, None); db.commit(); db.close()


def test_expired_synctoken_falls_back_to_full_resync():
    db = SessionLocal()
    try:
        _save_synctoken(db, CAL, "OLD_TOKEN"); db.commit()

        svc, calls = _service([], next_token="FRESH", gone_on_token=True)
        _run(db, svc)
        # It tried the token (410), then retried a full list, then stored a fresh cursor.
        assert any("syncToken" in p for p in calls["params"])
        assert any("timeMin" in p for p in calls["params"])
        assert _get_synctoken(db, CAL) == "FRESH"
    finally:
        _save_synctoken(db, CAL, None); db.commit(); db.close()
