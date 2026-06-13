"""Regression tests for the prod schema-drift P0: quotes whose ``valid_until``
comes back as a ``str`` (not a ``date``) used to 500 the public quote page and
break quote sending because several paths called ``.strftime()`` directly.

Covers the shared tolerant formatter, the PDF service, and the public serializer.
"""
import secrets

import pytest
from unittest.mock import patch
from datetime import date, datetime

from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Quote
from modules.quoting.router import _public_quote_dict, public_accept_quote
from services.quote_pdf_service import QuotePDFService
from sqlalchemy.orm.attributes import set_committed_value
from utils.dates import coerce_date, fmt_long_date


# ---- fmt_long_date / coerce_date unit tests --------------------------------

def test_fmt_long_date_from_date():
    assert fmt_long_date(date(2026, 7, 13)) == "July 13, 2026"


def test_fmt_long_date_from_datetime():
    assert fmt_long_date(datetime(2026, 7, 13, 9, 30)) == "July 13, 2026"


def test_fmt_long_date_from_iso_string():
    assert fmt_long_date("2026-07-13") == "July 13, 2026"
    # Full ISO timestamp string (only the date part matters).
    assert fmt_long_date("2026-07-13T09:30:00+00:00") == "July 13, 2026"


def test_fmt_long_date_empty_and_none():
    assert fmt_long_date("") is None
    assert fmt_long_date(None) is None


def test_fmt_long_date_garbage_does_not_raise():
    # Unparseable non-empty string is returned as-is rather than raising.
    assert fmt_long_date("not a date") == "not a date"


def test_coerce_date_variants():
    assert coerce_date(date(2026, 7, 13)) == date(2026, 7, 13)
    assert coerce_date(datetime(2026, 7, 13, 9, 30)) == date(2026, 7, 13)
    assert coerce_date("2026-07-13") == date(2026, 7, 13)
    assert coerce_date("") is None
    assert coerce_date(None) is None
    assert coerce_date("garbage") is None


# ---- PDF service tolerates a string expires_at -----------------------------

def test_pdf_generation_with_string_expires_at():
    pdf = QuotePDFService().generate_quote_pdf(
        quote_number="QT-DRIFT-1", client_name="A", client_email="a@x.com",
        client_phone=None, line_items=[], subtotal=100, tax_amount=0,
        discount_amount=0, total_amount=100, expires_at="2026-07-13",
    )
    assert pdf[:4] == b"%PDF"


def test_pdf_generation_with_garbage_expires_at():
    # An unparseable expiry must not crash PDF (and therefore quote) sending.
    pdf = QuotePDFService().generate_quote_pdf(
        quote_number="QT-DRIFT-2", client_name="A", client_email="a@x.com",
        client_phone=None, line_items=[], subtotal=100, tax_amount=0,
        discount_amount=0, total_amount=100, expires_at="whenever",
    )
    assert pdf[:4] == b"%PDF"


# ---- public serializer tolerates a string valid_until ----------------------

@pytest.fixture
def quote_ctx():
    db = SessionLocal()
    c = Client(name="Drift Test", email="cust@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-DRIFT-PUB", title="T",
              service_type="residential", address="1 St", notes="", items=[],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100, status="sent")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, q
    db.rollback()
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_public_quote_dict_with_string_valid_until(quote_ctx):
    db, c, q = quote_ctx
    # Simulate the drifted column reading back as a str (see test_quote_send).
    from sqlalchemy.orm.attributes import set_committed_value
    set_committed_value(q, "valid_until", "2026-07-13")
    out = _public_quote_dict(q, db)  # must not raise
    assert out["valid_until"] == "July 13, 2026"


def test_public_quote_dict_with_null_valid_until(quote_ctx):
    db, c, q = quote_ctx
    q.valid_until = None
    out = _public_quote_dict(q, db)
    assert out["valid_until"] is None


# ---- accept path tolerates a string valid_until ----------------------------
# The accept endpoint compared `quote.valid_until < date.today()`; with a
# drifted string column that raised "date < str" TypeError -> 500 on the
# customer's accept click. coerce_date() must make the comparison safe.

def _tokenize(db, q):
    q.public_token = secrets.token_urlsafe(16)
    db.commit()
    db.refresh(q)
    return q.public_token


def test_accept_with_future_string_valid_until(quote_ctx):
    db, c, q = quote_ctx
    token = _tokenize(db, q)
    set_committed_value(q, "valid_until", "2099-12-31")
    with patch("modules.quoting.router._notify_owner_quote_event"), \
         patch("modules.quoting.router._send_customer_quote_confirmation"):
        out = public_accept_quote(token, data=None, db=db)  # must not raise
    assert out["status"] == "accepted"
    db.refresh(q)
    assert q.status == "accepted"


def test_accept_with_past_string_valid_until_is_expired_not_500(quote_ctx):
    db, c, q = quote_ctx
    token = _tokenize(db, q)
    set_committed_value(q, "valid_until", "2000-01-01")
    with pytest.raises(HTTPException) as exc:
        public_accept_quote(token, data=None, db=db)
    assert exc.value.status_code == 409  # clean "expired", not a 500 TypeError
    db.refresh(q)
    assert q.status == "expired"
