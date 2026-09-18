"""The customer-facing invoice email must surface the self-service portal.

The portal (/portal — passwordless magic-link sign-in showing every visit,
quote and invoice) was fully built but undiscoverable: nothing the customer
receives ever pointed at it except one line buried in a Google Calendar invite.
The invoice is the recurring touchpoint a customer actually opens, so it now
carries a "view your portal" link in both the HTML and plain-text bodies.
"""
from integrations.email import build_invoice_email


def _invoice():
    return {
        "id": 1, "invoice_number": "INV-1001", "status": "sent",
        "due_date": "October 01, 2026", "subtotal": 100, "tax": 0,
        "discount": 0, "total": 100,
        "items": [{"name": "Standard clean", "qty": 1, "unit_price": 100}],
    }


def test_invoice_email_links_to_portal():
    html, plain = build_invoice_email(_invoice(), client_name="Meg Small")
    # Both bodies point the customer at their portal.
    assert "/portal" in html
    assert "/portal" in plain
    # And explain it's passwordless so a returning customer knows how to get in.
    assert "no password" in html.lower()
    assert "no password" in plain.lower()
