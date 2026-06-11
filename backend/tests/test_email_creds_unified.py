"""ONE canonical email credential chain for every sender.

quote_email_service read GMAIL_EMAIL/GMAIL_PASSWORD while everything else read
SMTP_USER/SMTP_PASS — so a Railway env with only one pair configured sent
invoices but silently failed quotes (or vice versa). Now everything goes
through integrations.email._load_smtp_creds(): DB settings → SMTP_* env →
legacy GMAIL_* env.
"""
import pytest
from unittest.mock import MagicMock, patch

from integrations.email import _load_smtp_creds

ALL_VARS = ("SMTP_USER", "SMTP_PASS", "GMAIL_EMAIL", "GMAIL_PASSWORD")


@pytest.fixture
def env_only(monkeypatch):
    """Silence the DB-settings layer so only the env fallback chain is tested."""
    for k in ALL_VARS:
        monkeypatch.delenv(k, raising=False)
    boom = MagicMock(side_effect=RuntimeError("no db in this test"))
    with patch("database.db.SessionLocal", boom):
        yield monkeypatch


def test_smtp_vars_are_canonical(env_only):
    env_only.setenv("SMTP_USER", "smtp@x.com")
    env_only.setenv("SMTP_PASS", "smtp-pass")
    env_only.setenv("GMAIL_EMAIL", "legacy@x.com")
    env_only.setenv("GMAIL_PASSWORD", "legacy-pass")
    creds = _load_smtp_creds()
    assert creds["smtp_user"] == "smtp@x.com"
    assert creds["smtp_pass"] == "smtp-pass"


def test_legacy_gmail_vars_still_work(env_only):
    env_only.setenv("GMAIL_EMAIL", "legacy@x.com")
    env_only.setenv("GMAIL_PASSWORD", "legacy-pass")
    creds = _load_smtp_creds()
    assert creds["smtp_user"] == "legacy@x.com"
    assert creds["smtp_pass"] == "legacy-pass"


def test_quote_email_service_uses_the_shared_chain(env_only):
    from services.quote_email_service import QuoteEmailService
    env_only.setenv("GMAIL_EMAIL", "legacy@x.com")
    env_only.setenv("GMAIL_PASSWORD", "legacy-pass")
    svc = QuoteEmailService()
    assert svc.smtp_user == "legacy@x.com"

    env_only.setenv("SMTP_USER", "smtp@x.com")
    env_only.setenv("SMTP_PASS", "smtp-pass")
    svc = QuoteEmailService()
    assert svc.smtp_user == "smtp@x.com"   # canonical pair wins


def test_missing_creds_error_names_the_expected_variables(env_only):
    from services.quote_email_service import QuoteEmailService
    with pytest.raises(ValueError) as ei:
        QuoteEmailService()
    msg = str(ei.value)
    assert "SMTP_USER" in msg and "SMTP_PASS" in msg and "GMAIL_EMAIL" in msg
