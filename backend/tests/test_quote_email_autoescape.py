"""Pins the July-2026 audit finding #7: the quote email template rendered
with Jinja2 autoescape OFF (jinja2.Template() defaults to unescaped), so a
customer-typed field like the service address — no HTML stripping happens
anywhere upstream — rendered raw HTML/script tags into an email this
company's own SMTP account sends. A `<script>` breaks the layout at best;
a crafted `<img onerror=...>` is a phishing/XSS vector at worst.

This test renders the real template string (services.quote_email_service
.QuoteEmailService.get_email_template) exactly the way send_quote_email
does — Template(..., autoescape=True) — and asserts a malicious address
comes out HTML-escaped, not live markup.
"""
from jinja2 import Template

from services.quote_email_service import QuoteEmailService


def _render(address):
    # get_email_template() is a static template string; it never reads
    # `self`, so we can call it unbound without going through __init__
    # (which requires real SMTP credentials to construct).
    template_str = QuoteEmailService.get_email_template(None)
    template = Template(template_str, autoescape=True)
    return template.render(
        company_name="Test Co", company_logo_url=None, quote_number="QT-2026-0099",
        quote_title="Test Quote", greeting_line="Hi there,", intro_message=None,
        items=[{"name": "Cleaning", "description": "", "qty": "1", "amount": "100.00"}],
        subtotal="100.00", tax="0.00", discount="0.00", tax_rate=None,
        show_tax=False, show_discount=False, total_amount="100.00",
        expires_at=None, address=address, quote_link="https://example.com/q/abc",
        pdf_attached=False, brand_color="#1f2937", company_email="test@example.com",
        company_phone=None, company_phone_href=None, terms=None,
        property_photo_url=None,
    )


def test_malicious_address_is_html_escaped_not_rendered_live():
    payload = '<script>alert(1)</script>'
    html = _render(payload)
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_img_onerror_payload_is_escaped():
    payload = '<img src=x onerror=alert(document.cookie)>'
    html = _render(payload)
    assert "<img src=x onerror=" not in html
    assert "&lt;img" in html


def test_normal_address_renders_unchanged_content():
    """Escaping must not corrupt a legitimate address."""
    html = _render("155 Keystone Dr, Waterboro, ME 04061")
    assert "155 Keystone Dr, Waterboro, ME 04061" in html


def test_ampersand_in_address_is_escaped_without_breaking_layout():
    html = _render("155 Smith & Sons Rd")
    assert "Smith &amp; Sons Rd" in html
