"""External-call timeouts regression tests.

The intermittent-502 spec traced the failure to a hung provider (SMTP,
IMAP, Twilio) blocking the single uvicorn worker. Timeouts were missing
on the SMTP and IMAP paths, and Twilio's Client defaulted to
block-indefinitely. These tests pin the guarantees so a future refactor
can't silently remove the ceilings.

We patch the underlying libraries so the tests never touch a real
provider; the only thing they check is that `timeout=` is passed with a
sensible default.
"""
import os
from unittest.mock import patch, MagicMock

# --- SMTP ------------------------------------------------------------------

def test_send_email_sets_smtplib_timeout(monkeypatch):
    from integrations import email as email_mod

    calls = {}

    class _FakeSMTP:
        def __init__(self, host, port, timeout=None):
            calls["host"] = host
            calls["port"] = port
            calls["timeout"] = timeout
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def ehlo(self): pass
        def starttls(self): pass
        def login(self, u, p): pass
        def sendmail(self, *a, **kw): pass

    monkeypatch.setattr(email_mod.smtplib, "SMTP", _FakeSMTP)
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USER", "u@example.com")
    monkeypatch.setenv("SMTP_PASS", "pw")
    monkeypatch.setenv("FROM_EMAIL", "u@example.com")

    email_mod.send_email(to="a@b.co", subject="hi", html_body="<p>hi</p>")
    assert calls["timeout"] == 30, "default SMTP timeout must be 30s"


def test_send_email_honors_smtp_timeout_env_override(monkeypatch):
    from integrations import email as email_mod

    calls = {}

    class _FakeSMTP:
        def __init__(self, host, port, timeout=None):
            calls["timeout"] = timeout
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def ehlo(self): pass
        def starttls(self): pass
        def login(self, u, p): pass
        def sendmail(self, *a, **kw): pass

    monkeypatch.setattr(email_mod.smtplib, "SMTP", _FakeSMTP)
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USER", "u@example.com")
    monkeypatch.setenv("SMTP_PASS", "pw")
    monkeypatch.setenv("FROM_EMAIL", "u@example.com")
    monkeypatch.setenv("SMTP_TIMEOUT_SECONDS", "5")

    email_mod.send_email(to="a@b.co", subject="hi", html_body="<p>hi</p>")
    assert calls["timeout"] == 5


# --- IMAP ------------------------------------------------------------------

def test_gmail_imap_connect_sets_timeout(monkeypatch):
    from integrations import gmail_inbox as inbox

    calls = {}

    def _fake_imap4_ssl(host, port, timeout=None):
        calls["host"] = host
        calls["port"] = port
        calls["timeout"] = timeout
        m = MagicMock()
        m.login = MagicMock(return_value=("OK", []))
        return m

    monkeypatch.setattr(inbox.imaplib, "IMAP4_SSL", _fake_imap4_ssl)
    monkeypatch.setattr(inbox, "_get_credentials",
                        lambda: ("u@example.com", "pw", "imap.example.com", 993, "smtp", 587))

    inbox._connect()
    assert calls["timeout"] == 30, "default IMAP timeout must be 30s"


def test_gmail_imap_honors_env_override(monkeypatch):
    from integrations import gmail_inbox as inbox

    calls = {}

    def _fake_imap4_ssl(host, port, timeout=None):
        calls["timeout"] = timeout
        m = MagicMock(); m.login = MagicMock(); return m

    monkeypatch.setattr(inbox.imaplib, "IMAP4_SSL", _fake_imap4_ssl)
    monkeypatch.setattr(inbox, "_get_credentials",
                        lambda: ("u@example.com", "pw", "imap.example.com", 993, "smtp", 587))
    monkeypatch.setenv("IMAP_TIMEOUT_SECONDS", "10")

    inbox._connect()
    assert calls["timeout"] == 10


# --- Twilio ----------------------------------------------------------------

def test_twilio_client_uses_bounded_http_timeout(monkeypatch):
    from integrations import twilio_client

    captured = {}

    class _FakeHttpClient:
        def __init__(self, timeout=None):
            captured["http_timeout"] = timeout

    class _FakeClient:
        def __init__(self, sid, tok, http_client=None):
            captured["sid"] = sid
            captured["tok"] = tok
            captured["http_client"] = http_client

    monkeypatch.setattr(twilio_client, "TwilioHttpClient", _FakeHttpClient)
    monkeypatch.setattr(twilio_client, "Client", _FakeClient)
    monkeypatch.setattr(twilio_client, "_TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setattr(twilio_client, "_TWILIO_AUTH_TOKEN", "tok_test")

    twilio_client._client()
    assert captured["http_timeout"] == 30, "default Twilio timeout must be 30s"
    assert captured["http_client"] is not None
