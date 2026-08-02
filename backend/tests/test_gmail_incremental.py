"""Phase E: incremental Gmail sync via the History API.

Hermetic — no network. A fake Gmail service stands in for the googleapiclient
`build(...)` result, so we exercise fetch_inbox_incremental's history walk,
INBOX filtering, dedup, cursor advance, and the HistoryExpired (404) path.
"""
import pytest

import integrations.gmail_api as ga


# ── Fake Gmail service ─────────────────────────────────────────────────────

class _HttpErrResp:
    def __init__(self, status): self.status = status


class _FakeHttpError(Exception):
    def __init__(self, status): self.resp = _HttpErrResp(status)


class _Exec:
    def __init__(self, value): self._value = value
    def execute(self):
        if isinstance(self._value, Exception):
            raise self._value
        return self._value


class _Messages:
    def __init__(self, msgs): self._msgs = msgs
    def get(self, userId, id, format):
        return _Exec(self._msgs[id])


class _History:
    def __init__(self, pages, error=None):
        self._pages, self._error, self._i = pages, error, 0
    def list(self, **kw):
        if self._error:
            return _Exec(self._error)
        page = self._pages[self._i]
        self._i += 1
        return _Exec(page)


class _Users:
    def __init__(self, svc): self._svc = svc
    def messages(self): return _Messages(self._svc._msgs)
    def history(self): return _History(self._svc._pages, self._svc._hist_error)
    def getProfile(self, userId): return _Exec({"historyId": "9999"})


class _FakeService:
    def __init__(self, msgs, pages, hist_error=None):
        self._msgs, self._pages, self._hist_error = msgs, pages, hist_error
    def users(self): return _Users(self)


def _msg(mid, sender="alice@example.com", labels=("INBOX",)):
    return {
        "id": mid, "snippet": "hi", "labelIds": list(labels),
        "payload": {"headers": [
            {"name": "From", "value": f"Alice <{sender}>"},
            {"name": "Message-ID", "value": f"<{mid}@example.com>"},
            {"name": "Subject", "value": "Hello"},
            {"name": "Date", "value": "Mon, 02 Aug 2026 10:00:00 -0400"},
            {"name": "To", "value": "me@biz.com"},
        ]},
    }


@pytest.fixture(autouse=True)
def _patch_http_error(monkeypatch):
    # fetch_inbox_incremental imports HttpError from googleapiclient.errors at
    # call time — swap it for our lightweight stand-in so a fake 404 is caught.
    import googleapiclient.errors as errmod
    monkeypatch.setattr(errmod, "HttpError", _FakeHttpError, raising=False)


def test_incremental_collects_added_inbox_messages(monkeypatch):
    msgs = {"m1": _msg("m1"), "m2": _msg("m2")}
    pages = [{
        "historyId": "1010",
        "history": [
            {"messagesAdded": [{"message": {"id": "m1", "labelIds": ["INBOX"]}}]},
            {"messagesAdded": [{"message": {"id": "m2", "labelIds": ["INBOX"]}}]},
        ],
    }]
    monkeypatch.setattr(ga, "_service", lambda creds: _FakeService(msgs, pages))

    out = ga.fetch_inbox_incremental(object(), "1000")
    assert out["new_history_id"] == "1010"
    ids = sorted(m["id"] for m in out["messages"])
    assert ids == ["m1", "m2"]


def test_incremental_skips_non_inbox_and_dedupes(monkeypatch):
    msgs = {"m1": _msg("m1"), "m3": _msg("m3", labels=["SENT"])}
    pages = [{
        "historyId": "2020",
        "history": [
            {"messagesAdded": [{"message": {"id": "m1", "labelIds": ["INBOX"]}}]},
            {"messagesAdded": [{"message": {"id": "m1", "labelIds": ["INBOX"]}}]},  # dup
            {"messagesAdded": [{"message": {"id": "m3", "labelIds": ["SENT"]}}]},   # not INBOX
        ],
    }]
    monkeypatch.setattr(ga, "_service", lambda creds: _FakeService(msgs, pages))

    out = ga.fetch_inbox_incremental(object(), "2000")
    assert [m["id"] for m in out["messages"]] == ["m1"]   # deduped, SENT excluded


def test_incremental_raises_history_expired_on_404(monkeypatch):
    monkeypatch.setattr(
        ga, "_service",
        lambda creds: _FakeService({}, [], hist_error=_FakeHttpError(404)),
    )
    with pytest.raises(ga.HistoryExpired):
        ga.fetch_inbox_incremental(object(), "1")


def test_incremental_empty_window_keeps_cursor(monkeypatch):
    pages = [{"historyId": "3030"}]  # no `history` key = nothing new
    monkeypatch.setattr(ga, "_service", lambda creds: _FakeService({}, pages))
    out = ga.fetch_inbox_incremental(object(), "3000")
    assert out["messages"] == []
    assert out["new_history_id"] == "3030"
