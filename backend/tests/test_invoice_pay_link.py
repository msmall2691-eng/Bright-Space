"""The invoice a customer receives must carry the link to pay it.

This is the gap that made online payment unreachable. `send_invoice` mints
`Invoice.public_token`, so /pay/{token} resolved and the page worked — but
nothing the customer got ever contained that URL. The email pointed only at
/portal (magic-link sign-in, a different thing) and the SMS carried no link at
all. A pay page nobody is given the address of is a pay page nobody uses, and
no test asserted otherwise, which is why it shipped that way.

The wording follows what the server can actually do: "Pay now" only when
Stripe is configured AND a balance is owed, "View invoice" otherwise. That
matters because the page itself falls back to "call/text us" when payment is
off — a button promising payment that lands on "call us" is worse than a
neutral link.
"""
import pytest

from integrations.email import build_invoice_email, build_invoice_sms

TOKEN = "tok_abc123"


def _invoice(**over):
    inv = {
        "id": 1, "invoice_number": "INV-1001", "status": "sent",
        "due_date": "October 15, 2026", "subtotal": 450, "tax": 0,
        "discount": 0, "total": 450,
        "items": [{"name": "Deep clean", "qty": 1, "unit_price": 450}],
        "public_token": TOKEN,
    }
    inv.update(over)
    return inv


@pytest.fixture
def stripe_on(monkeypatch):
    import integrations.stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: True)
    monkeypatch.setattr(sc, "webhook_secret", lambda: "whsec_test")


@pytest.fixture
def stripe_off(monkeypatch):
    import integrations.stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: False)


# -- email -------------------------------------------------------------------

def test_email_offers_to_take_payment_when_stripe_is_on(stripe_on):
    html, plain = build_invoice_email(_invoice(), client_name="Meg Small")
    assert f"/pay/{TOKEN}" in html
    assert f"/pay/{TOKEN}" in plain
    # Names the amount, so the customer knows what they are authorising.
    assert "Pay $450.00 online" in html
    assert "450.00" in plain
    # And is honest that card details never reach us.
    assert "never see your card" in html.lower()


def test_email_links_the_invoice_but_promises_nothing_when_stripe_is_off(stripe_off):
    """The page falls back to "call/text us" with payment off, so the email
    must not call it a pay button."""
    html, plain = build_invoice_email(_invoice(), client_name="Meg Small")
    assert f"/pay/{TOKEN}" in html
    assert "View this invoice online" in html
    assert "Pay $450.00 online" not in html
    assert "View this invoice" in plain


def test_a_paid_invoice_is_not_asked_to_pay_again(stripe_on):
    html, _plain = build_invoice_email(_invoice(status="paid"), client_name="Meg Small")
    assert "Pay $450.00 online" not in html
    assert f"/pay/{TOKEN}" in html, "a receipt should still link to the invoice"


def test_no_token_means_no_link_rather_than_a_broken_one(stripe_on):
    """Older invoices, and callers passing a minimal dict, have no token. A
    half-built /pay/None URL is worse than no link."""
    inv = _invoice()
    del inv["public_token"]
    html, plain = build_invoice_email(inv, client_name="Meg Small")
    assert "/pay/" not in html
    assert "/pay/" not in plain


def test_the_portal_link_survived(stripe_on):
    """The pay link is additive — /portal is a different capability (every
    visit, quote and invoice) and test_invoice_email_portal_link.py exists
    because it was once undiscoverable too."""
    html, plain = build_invoice_email(_invoice(), client_name="Meg Small")
    assert "/portal" in html and "/portal" in plain


# -- SMS ---------------------------------------------------------------------

def test_sms_carries_the_link(stripe_on):
    """The one channel where "look in your email" is no answer."""
    body = build_invoice_sms(_invoice(), client_name="Meg Small")
    assert f"/pay/{TOKEN}" in body
    assert "Pay online" in body


def test_sms_says_view_not_pay_when_stripe_is_off(stripe_off):
    body = build_invoice_sms(_invoice(), client_name="Meg Small")
    assert f"/pay/{TOKEN}" in body
    assert "View invoice" in body
    assert "Pay online" not in body


def test_sms_without_a_token_is_still_a_valid_message(stripe_on):
    inv = _invoice()
    del inv["public_token"]
    body = build_invoice_sms(inv, client_name="Meg Small")
    assert "/pay/" not in body
    assert "Invoice INV-1001" in body
    assert "Reply to this message" in body


# -- the overdue chase, which is the one most likely to be acted on ----------

def test_the_dunning_reminder_carries_the_token(stripe_on):
    """`_invoice_to_email_dict` is a hand-maintained shape, so a key added to
    the invoicing router's dict does not reach it automatically — and a chase
    email that asks for money without saying where to send it is the worst
    place to drop the link."""
    from services.dunning_service import _invoice_to_email_dict

    class _Inv:
        id = 7
        invoice_number = "INV-1007"
        items = [{"name": "Standard clean", "qty": 1, "unit_price": 150}]
        subtotal = 150
        tax_rate = 0
        tax = 0
        discount = 0
        total = 150
        due_date = "September 01, 2026"
        notes = None
        public_token = TOKEN

    d = _invoice_to_email_dict(_Inv())
    assert d["public_token"] == TOKEN
    html, plain = build_invoice_email(d, client_name="Meg Small")
    assert f"/pay/{TOKEN}" in html and f"/pay/{TOKEN}" in plain
