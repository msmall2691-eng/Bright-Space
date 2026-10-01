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


# -- Codex P2s: both were ways the link could be worse than no link ----------

def test_a_zero_total_invoice_is_never_offered_for_payment(stripe_on):
    """`start_checkout` refuses `due <= 0` with "There's nothing left to pay",
    so an email offering "Pay $0.00 online" is a button that always 409s. A
    `sent` invoice CAN total zero — nothing constrains the computed total, so
    no items or a discount that cancels it out gets you there."""
    html, plain = build_invoice_email(_invoice(total=0, subtotal=0), client_name="Meg Small")
    assert "Pay $0.00 online" not in html
    assert "View this invoice online" in html, "it should still be viewable"
    assert f"/pay/{TOKEN}" in html and f"/pay/{TOKEN}" in plain

    body = build_invoice_sms(_invoice(total=0, subtotal=0), client_name="Meg Small")
    assert "Pay online" not in body
    assert "View invoice" in body


def test_a_negative_total_is_not_offered_either(stripe_on):
    html, _ = build_invoice_email(_invoice(total=-25), client_name="Meg Small")
    assert "online" not in html.split("Payment due by")[-1][:200] or "View this invoice" in html
    assert "Pay $-25.00 online" not in html


# -- the send handler: a token in somebody's inbox must exist in the database -

def test_a_half_possible_send_delivers_nothing_and_keeps_no_token(monkeypatch):
    """Codex P2, and the nastier of the two.

    `channel="both"` with an email but no phone used to send the email — which
    now carries /pay/{token} — and only THEN raise 400 on the missing phone.
    The token was still uncommitted, so it rolled back when the session closed
    and the customer was left holding a pay link that 404s forever. Nothing
    asserted the ordering, which is why it survived.

    Validate every destination first: an impossible request fails having sent
    nothing and written nothing.
    """
    import uuid
    from fastapi import HTTPException
    from database.db import SessionLocal
    from database.models import Client, Invoice
    from modules.invoicing import router as inv_router

    db = SessionLocal()
    c = Client(name="No Phone LLC", email="nophone@example.com", phone=None, status="active")
    db.add(c); db.commit(); db.refresh(c)
    inv = Invoice(client_id=c.id, invoice_number=None,
                  items=[{"name": "Clean", "qty": 1, "unit_price": 100}],
                  subtotal=100, tax_rate=0, tax=0, discount=0, total=100,
                  status="draft", due_date="October 20, 2026")
    db.add(inv); db.commit(); db.refresh(inv)
    inv_id = inv.id

    sent = []
    monkeypatch.setattr("integrations.email.send_email",
                        lambda **kw: sent.append(kw))

    try:
        with pytest.raises(HTTPException) as e:
            inv_router.send_invoice(inv_id, inv_router.SendInvoiceRequest(channel="both"), db=db)
        assert e.value.status_code == 400
        assert "phone" in str(e.value.detail).lower()
        assert sent == [], "an email went out on a request that could not be completed"

        db.rollback()
        fresh = db.query(Invoice).filter(Invoice.id == inv_id).first()
        assert fresh.public_token is None, \
            "a pay token was minted for a send that never happened"
    finally:
        db.rollback()
        db.query(Invoice).filter(Invoice.id == inv_id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_the_token_is_committed_before_the_email_goes_out(monkeypatch):
    """The other half: once a link has left the building it must already be in
    the database, so a later crash cannot orphan it."""
    import uuid
    from database.db import SessionLocal
    from database.models import Client, Invoice
    from modules.invoicing import router as inv_router

    db = SessionLocal()
    c = Client(name="Has Email LLC", email="has@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    inv = Invoice(client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:5]}",
                  items=[{"name": "Clean", "qty": 1, "unit_price": 100}],
                  subtotal=100, tax_rate=0, tax=0, discount=0, total=100,
                  status="draft", due_date="October 20, 2026")
    db.add(inv); db.commit(); db.refresh(inv)
    inv_id = inv.id

    seen = {}

    def _capture(**kw):
        # At the moment of sending, a SEPARATE session must already see the
        # token — i.e. it is committed, not merely set in memory.
        other = SessionLocal()
        try:
            seen["token"] = other.query(Invoice).filter(
                Invoice.id == inv_id).first().public_token
        finally:
            other.close()

    monkeypatch.setattr("integrations.email.send_email", _capture)

    try:
        inv_router.send_invoice(inv_id, inv_router.SendInvoiceRequest(channel="email"), db=db)
        assert seen.get("token"), \
            "the email was sent before the pay token was committed"
    finally:
        db.rollback()
        from database.models import Message
        db.query(Message).filter(Message.client_id == c.id).delete(synchronize_session=False)
        db.query(Invoice).filter(Invoice.id == inv_id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
