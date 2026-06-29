"""Quote customization (June 12 feature): editable title + customer message,
per-send subject/greeting, the personal note reaching EMAIL (not just SMS),
and the June-11 paper cuts — "Hello +12074329492", "$183.0", and the footer
claiming "valid for 30 days" on quotes with no expiry.
"""
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Quote, AppSetting
from modules.quoting.router import (
    send_quote, QuoteSendRequest, _quote_dict, _public_quote_dict, _apply_update,
)
from services.quote_email_service import customer_display_name, format_money


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Jane Doe", email="jane@example.com", phone="+12075551234", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-CUST-1", title="Deep clean — 5 Elm St",
              customer_message="Thanks for having us out — here's the quote we discussed.",
              service_type="residential", address="5 Elm St", notes="",
              items=[{"name": "Deep clean", "description": "", "qty": 1, "unit_price": 183}],
              subtotal=183, tax_rate=0, tax=0, discount=0, total=183, status="draft")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, q
    db.rollback()
    from database.models import IntegrationEvent
    db.query(IntegrationEvent).filter(
        IntegrationEvent.entity_type == "quote",
        IntegrationEvent.entity_id == q.id,
    ).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    for k in ("company_name", "company_email", "company_phone", "quote_terms"):
        db.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    db.commit(); db.close()


def test_money_formatting_never_python_float_repr():
    assert format_money(183.0) == "183.00"      # the "$183.0" bug
    assert format_money(1234.5) == "1,234.50"
    assert format_money(None) == "0.00"
    assert format_money("abc") == "0.00"


def test_custom_fields_persist_and_serialize(ctx):
    """Admin-defined custom fields save on update and round-trip through the
    quote serialization the UI reads."""
    db, c, q = ctx
    # Nothing set yet → empty dict (never null) in the serialized shape.
    assert _quote_dict(q)["custom_fields"] == {}
    _apply_update(q, {"custom_fields": {"gate_code": "1234", "pets": "2 dogs"}})
    db.commit(); db.refresh(q)
    assert q.custom_fields == {"gate_code": "1234", "pets": "2 dogs"}
    assert _quote_dict(q)["custom_fields"]["gate_code"] == "1234"
    # An update that doesn't include custom_fields must not wipe them.
    _apply_update(q, {"title": "New title"})
    assert q.custom_fields == {"gate_code": "1234", "pets": "2 dogs"}


def test_placeholder_names_are_not_greeted():
    assert customer_display_name("+12074329492") == ""   # "Hello +12074329492"
    assert customer_display_name("(207) 432-9492") == ""
    assert customer_display_name("BrightBase Webhook Test") == ""
    assert customer_display_name(None) == ""
    assert customer_display_name("Jane Doe") == "Jane Doe"


def test_title_and_customer_message_round_trip(ctx):
    db, c, q = ctx
    d = _quote_dict(q)
    assert d["title"] == "Deep clean — 5 Elm St"
    assert d["customer_message"].startswith("Thanks for having us out")
    # Fully re-editable after creation.
    _apply_update(q, {"title": "Move-out clean", "customer_message": "Updated note"})
    db.commit(); db.refresh(q)
    assert q.title == "Move-out clean"
    assert q.customer_message == "Updated note"


def test_public_dict_has_title_message_contact_and_terms(ctx):
    db, c, q = ctx
    for k, v in (("company_name", "Maine Cleaning Co"),
                 ("company_email", "office@mainecleaningco.com"),
                 ("company_phone", "+12075550100"),
                 ("quote_terms", "Payment due upon completion.")):
        db.add(AppSetting(key=k, value=v))
    db.commit()
    d = _public_quote_dict(q, db)
    assert d["title"] == q.title
    assert d["customer_message"] == q.customer_message
    assert d["company_name"] == "Maine Cleaning Co"     # Settings beat env
    assert d["company_email"] == "office@mainecleaningco.com"
    assert d["company_phone"] == "+12075550100"
    assert d["terms"] == "Payment due upon completion."


def test_send_passes_envelope_and_note_to_email(ctx):
    db, c, q = ctx
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "e-envelope"}
        send_quote(q.id, QuoteSendRequest(
            channel="email", subject="Your spring cleaning quote",
            greeting="Jane", custom_message="Great meeting you today!",
        ), db=db)
    kwargs = Email.return_value.send_quote_email.call_args.kwargs
    assert kwargs["subject"] == "Your spring cleaning quote"
    assert kwargs["greeting"] == "Jane"
    assert kwargs["intro_message"] == "Great meeting you today!"  # note reaches EMAIL now
    assert kwargs["quote_title"] == q.title
    assert kwargs["items"] and kwargs["items"][0]["name"] == "Deep clean"
    assert kwargs["expires_at"] is None        # no made-up expiry


def test_send_falls_back_to_stored_customer_message(ctx):
    db, c, q = ctx
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "e-fallback"}
        send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    kwargs = Email.return_value.send_quote_email.call_args.kwargs
    assert kwargs["intro_message"].startswith("Thanks for having us out")


def test_sms_default_never_greets_a_phone_number(ctx):
    db, c, q = ctx
    c.name = "+12074329492"
    db.commit()
    with patch("integrations.twilio_client.send_sms", return_value={"sid": "S1"}) as sms:
        send_quote(q.id, QuoteSendRequest(channel="sms"), db=db)
    body = sms.call_args.kwargs.get("body") or sms.call_args.args[1]
    assert "+12074329492" not in body.split("View & accept")[0]
    assert body.startswith("Hi, your quote")


def _rendered_email(monkeypatch, **overrides):
    """Send through the real service with SMTP mocked; return (msg, html)."""
    monkeypatch.setenv("SMTP_USER", "office@x.com")
    monkeypatch.setenv("SMTP_PASS", "pw")
    from services.quote_email_service import QuoteEmailService
    with patch("database.db.SessionLocal", side_effect=RuntimeError("no db")), \
         patch("smtplib.SMTP") as SMTP:
        svc = QuoteEmailService()
        params = dict(
            to_email="jane@example.com", client_name="+12074329492",
            quote_number="QT-CUST-1", total_amount=183.0, expires_at=None,
            quote_link="https://x/quote/tok", pdf_bytes=b"%PDF",
            quote_title="Deep clean — 5 Elm St",
            intro_message="Thanks again!",
            items=[{"name": "Deep clean", "description": "Whole house", "qty": 1, "unit_price": 183}],
        )
        params.update(overrides)
        res = svc.send_quote_email(**params)
        assert res["success"], res
        msg = SMTP.return_value.__enter__.return_value.send_message.call_args[0][0]
    html = msg.get_payload(0).get_payload(decode=True).decode()
    return msg, html


def test_email_contents_fix_all_june11_findings(monkeypatch):
    msg, html = _rendered_email(monkeypatch)
    assert "183.00" in html and "$183.0<" not in html        # money formatting
    assert "Hello," in html and "+12074329492" not in html   # no phone greeting
    assert "30 days" not in html                             # no contradictory footer
    assert "Valid until" not in html                         # no expiry invented
    assert "Deep clean" in html and "Whole house" in html    # real line items
    assert "Thanks again!" in html                           # note included in email
    assert "Deep clean — 5 Elm St" in msg["Subject"] or "QT-CUST-1" in msg["Subject"]


def test_email_with_pdf_is_mixed_so_body_renders(monkeypatch):
    """Regression: with a PDF attached, the message must be multipart/mixed —
    HTML body part AND a separate PDF attachment. Under multipart/alternative,
    iOS Mail rendered the PDF and hid the body (so the customer never saw the
    'View & Accept' button / link)."""
    msg, html = _rendered_email(monkeypatch)
    assert msg.get_content_type() == "multipart/mixed"
    parts = msg.get_payload()
    assert parts[0].get_content_type() == "text/html"
    # The PDF is a real, separate attachment — not an alternative to the body.
    pdfs = [p for p in parts if p.get_content_type() == "application/pdf"]
    assert len(pdfs) == 1
    assert pdfs[0].get("Content-Disposition", "").startswith("attachment")
    # The clickable button + its link survive in the (now-rendered) body.
    assert "View &amp; Accept Your Quote" in html and "https://x/quote/tok" in html


def test_email_subject_greeting_and_expiry_overrides(monkeypatch):
    msg, html = _rendered_email(
        monkeypatch, subject="Custom subject line", greeting="Jane",
        expires_at="June 30, 2026",
    )
    assert msg["Subject"] == "Custom subject line"
    assert "Hello Jane," in html
    # Validity is shown exactly once now — the "Valid until" row in the info box,
    # no longer repeated as a separate footer sentence.
    assert "Valid until" in html and "June 30, 2026" in html
    assert "valid for 30 days" not in html


def test_settings_general_round_trip():
    db = SessionLocal()
    try:
        from modules.settings.router import save_general_settings, get_general_settings, GeneralSettings
        save_general_settings(GeneralSettings(
            company_name="Maine Cleaning Co", company_phone="+12075550100",
            quote_terms="Be excellent."), db=db)
        out = get_general_settings(db=db)
        assert out["company_name"] == "Maine Cleaning Co"
        assert out["company_phone"] == "+12075550100"
        assert out["quote_terms"] == "Be excellent."
    finally:
        for k in ("company_name", "company_email", "company_phone",
                  "timezone", "currency", "quote_terms"):
            db.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
        db.commit(); db.close()


def test_email_keeps_explicit_zero_quantities(monkeypatch):
    """Codex P2 (#267): a qty-0 line must not be billed as qty 1 in the email
    while the persisted total treats it as zero."""
    msg, html = _rendered_email(monkeypatch, items=[
        {"name": "Deep clean", "description": "", "qty": 0, "unit_price": 183},
        {"name": "Windows", "description": "", "qty": None, "unit_price": 50},
    ], total_amount=50)
    assert ">0<" in html.replace(" ", "")      # qty column shows 0
    assert "$0.00" in html                     # amount for the zero-qty line
    assert "$50.00" in html                    # missing qty still defaults to 1
    assert "$183.00" not in html               # never billed the zero-qty item


def test_email_company_name_comes_from_settings(monkeypatch):
    """Codex P2 (#267): Settings → General Company Name must drive the email
    header/sender/subject, not just the public page."""
    db = SessionLocal()
    db.add(AppSetting(key="company_name", value="Maine Cleaning Co"))
    db.commit()
    try:
        monkeypatch.setenv("SMTP_USER", "office@x.com")
        monkeypatch.setenv("SMTP_PASS", "pw")
        monkeypatch.delenv("COMPANY_NAME", raising=False)
        from services.quote_email_service import QuoteEmailService
        with patch("smtplib.SMTP") as SMTP:
            svc = QuoteEmailService()
            assert svc.company_name == "Maine Cleaning Co"
            svc.send_quote_email(to_email="jane@example.com", client_name="Jane",
                                 quote_number="QT-1", total_amount=10, expires_at=None,
                                 quote_link="https://x/q/t")
            msg = SMTP.return_value.__enter__.return_value.send_message.call_args[0][0]
        assert "Maine Cleaning Co" in msg["Subject"]
        assert "Maine Cleaning Co" in msg["From"]
    finally:
        db.query(AppSetting).filter(AppSetting.key == "company_name").delete(synchronize_session=False)
        db.commit(); db.close()


def test_brand_color_is_validated_and_normalized():
    """Codex P2 (#269): a malformed brand color must never reach the DB —
    colors.HexColor() raises inside PDF generation, which precedes email
    delivery, so quote sends would fail until the setting was fixed."""
    from fastapi import HTTPException
    from modules.settings.router import _normalize_brand_color
    assert _normalize_brand_color("#1F2937") == "#1f2937"
    assert _normalize_brand_color("1f2937") == "#1f2937"
    assert _normalize_brand_color("#abc") == "#aabbcc"
    for bad in ("red", "not-a-color", "#12345", "#gggggg"):
        with pytest.raises(HTTPException):
            _normalize_brand_color(bad)


def test_pdf_survives_a_bad_stored_brand_color():
    """Belt-and-braces: even a legacy/hand-edited bad value falls back to the
    default instead of breaking PDF generation."""
    from services.quote_pdf_service import QuotePDFService
    svc = QuotePDFService(brand_color="not-a-color")
    assert svc.brand_color == "#1f2937"
    pdf = svc.generate_quote_pdf(
        quote_number="QT-X", client_name="Jane", client_email="j@x.com",
        client_phone=None, line_items=[], subtotal=0, tax_amount=0,
        discount_amount=0, total_amount=0,
    )
    assert pdf.startswith(b"%PDF")
