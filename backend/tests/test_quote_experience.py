"""Quote Experience v2 — backend behaviors.

Covers: flat 30-day validity default, the public PDF endpoint (inline vs
download), and the email money-breakdown / address / tel-href upgrades.
"""
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Quote
from schemas.quotes import QuoteCreate
from modules.quoting.router import create_quote, public_quote_pdf


@pytest.fixture
def client_ctx():
    db = SessionLocal()
    c = Client(name="Exp Test", email="exp@example.com", phone="+12075551212", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.rollback()
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


# ---- A: flat 30-day validity default ---------------------------------------

def test_create_quote_defaults_valid_until_to_30_days(client_ctx):
    db, c = client_ctx
    user = SimpleNamespace(id=None)
    out = create_quote(QuoteCreate(client_id=c.id, title="T", items=[]), db=db, current_user=user)
    q = db.query(Quote).filter(Quote.id == out["id"]).first()
    assert q.valid_until == date.today() + timedelta(days=30)


def test_create_quote_respects_explicit_valid_until(client_ctx):
    db, c = client_ctx
    user = SimpleNamespace(id=None)
    out = create_quote(QuoteCreate(client_id=c.id, title="T", items=[], valid_until="2026-08-01"),
                       db=db, current_user=user)
    q = db.query(Quote).filter(Quote.id == out["id"]).first()
    assert q.valid_until == date(2026, 8, 1)


# ---- B: public PDF endpoint ------------------------------------------------

def _mk_quote(db, c, token):
    q = Quote(client_id=c.id, quote_number=f"QT-EXP-{token[:4]}", title="T",
              service_type="residential", address="1 St", notes="", items=[],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100, status="sent",
              public_token=token, valid_until=date.today() + timedelta(days=30))
    db.add(q); db.commit(); db.refresh(q)
    return q


def test_public_pdf_inline_by_default(client_ctx):
    db, c = client_ctx
    q = _mk_quote(db, c, "tokinline1")
    resp = public_quote_pdf("tokinline1", download=False, db=db)
    assert resp.media_type == "application/pdf"
    assert resp.headers["content-disposition"].startswith("inline")
    assert f"{q.quote_number}.pdf" in resp.headers["content-disposition"]


def test_public_pdf_download_forces_attachment(client_ctx):
    db, c = client_ctx
    _mk_quote(db, c, "tokdl12345")
    resp = public_quote_pdf("tokdl12345", download=True, db=db)
    assert resp.headers["content-disposition"].startswith("attachment")


# ---- C: email breakdown / address / tel href -------------------------------

def _render_email(monkeypatch, **overrides):
    monkeypatch.setenv("SMTP_USER", "office@x.com")
    monkeypatch.setenv("SMTP_PASS", "pw")
    monkeypatch.setenv("COMPANY_PHONE", "+1 (207) 555-1212")
    from services.quote_email_service import QuoteEmailService
    with patch("database.db.SessionLocal", side_effect=RuntimeError("no db")), \
         patch("smtplib.SMTP") as SMTP:
        svc = QuoteEmailService()
        params = dict(
            to_email="jane@example.com", client_name="Megan Small",
            quote_number="QT-EXP-1", total_amount=240.0, expires_at="July 13, 2026",
            quote_link="https://x/quote/tok", pdf_bytes=b"%PDF",
            items=[{"name": "Clean", "qty": 1, "unit_price": 200}],
            subtotal=200, tax=40, discount=0, tax_rate=20, address="5 Elm St",
        )
        params.update(overrides)
        res = svc.send_quote_email(**params)
        assert res["success"], res
        msg = SMTP.return_value.__enter__.return_value.send_message.call_args[0][0]
    html = msg.get_payload(0).get_payload(decode=True).decode()
    return msg, html


def test_email_shows_breakdown_and_address_and_first_name(monkeypatch):
    msg, html = _render_email(monkeypatch)
    assert "Subtotal" in html and "200.00" in html
    assert "Tax" in html and "40.00" in html          # shown because tax > 0
    assert "Discount" not in html                      # hidden at $0
    assert "5 Elm St" in html                          # service address shown
    assert "Hi Megan," in html                         # first-name greeting
    assert "$240.00 quote" in msg["Subject"]           # price in subject


def test_email_hides_tax_when_zero(monkeypatch):
    msg, html = _render_email(monkeypatch, tax=0, tax_rate=0, total_amount=200.0)
    assert "Subtotal" in html
    assert "Tax" not in html and "Discount" not in html


def test_email_tel_href_is_digits_only(monkeypatch):
    msg, html = _render_email(monkeypatch)
    # The visible number stays formatted, but the href must dial.
    assert 'href="tel:+12075551212"' in html or 'tel:+1207' in html
