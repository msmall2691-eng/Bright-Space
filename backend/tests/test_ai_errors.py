"""friendly_ai_error must never leak raw provider internals to the user."""
from utils.ai_errors import friendly_ai_error


class _CreditError(Exception):
    pass


class AuthenticationError(Exception):
    pass


class RateLimitError(Exception):
    pass


def test_credit_balance_is_friendly():
    e = _CreditError("Error code: 400 - {'type': 'error', 'error': {'message': "
                     "'Your credit balance is too low to access the Anthropic API'}}, "
                     "request_id: req_abc123")
    msg = friendly_ai_error(e)
    assert "credit balance" not in msg.lower()
    assert "request_id" not in msg.lower()
    assert "administrator" in msg.lower()


def test_auth_error_friendly():
    assert "api key" in friendly_ai_error(AuthenticationError("invalid x-api-key")).lower()


def test_rate_limit_friendly():
    assert "busy" in friendly_ai_error(RateLimitError("429 rate limit exceeded")).lower()


def test_generic_error_has_no_internals():
    msg = friendly_ai_error(RuntimeError("KeyError at line 42 traceback ..."))
    assert "traceback" not in msg.lower()
    assert "line 42" not in msg.lower()
    assert msg  # non-empty, user-safe
