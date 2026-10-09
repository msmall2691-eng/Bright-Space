"""`POST /api/invoices/{id}/generate-token` — the pay link InvoiceDetail can offer.

`invoice_to_dict` has carried a `public_token` since the pay page shipped, with
a comment saying it is there so "InvoiceDetail can show/copy the customer's
pay-page link". InvoiceDetail never read it, and `_ensure_invoice_public_token`
was only ever called from the SEND handler — so on an invoice nobody had sent
there was no token to show, which is exactly when someone wants to read the
link down the phone.

This endpoint mints on demand, mirroring `POST /api/quotes/{id}/generate-token`.

**Not to be confused with `test_invoice_pay_link.py`**, which covers the
CUSTOMER side of the same token: that the invoice email and SMS actually carry
`/pay/{token}`, and that a missing token yields no link rather than a
`/pay/None`. This file is the OFFICE side — minting the token so there is one
to carry. The two meet at the trap that file already names: a half-built URL is
worse than no URL, which is why the button here goes to the server instead of
formatting whatever is on screen.

What is worth pinning, in order of how much it would cost to get wrong:

1. **Idempotence.** The token is a bearer credential a customer may already
   hold. If copying rotated it, the link in their inbox would stop working and
   nothing would say why. `_ensure_invoice_public_token` returns the existing
   token untouched; this proves the endpoint does not defeat that.
2. **Tenant scope.** It mints a credential from a path id, which is the shape
   the properties router had nine of without an org filter (#1133).
3. **The link's host.** Built from `app_base_url()`, not the caller's origin,
   so an office user on a preview host cannot hand the customer a URL only the
   office can reach. The one real behavioural difference from QuoteDetail,
   which copies `window.location.origin`.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Invoice, Org
from modules.invoicing.router import generate_invoice_token


@pytest.fixture
def made():
    ids = {"invoices": [], "clients": []}
    yield ids
    db = SessionLocal()
    if ids["invoices"]:
        db.query(Invoice).filter(Invoice.id.in_(ids["invoices"])).delete(synchronize_session=False)
    if ids["clients"]:
        db.query(Client).filter(Client.id.in_(ids["clients"])).delete(synchronize_session=False)
    db.commit()
    db.close()


def _unsent_invoice(db, made, org_id=None):
    """A draft nobody has sent, so `public_token` is NULL — the case the send
    handler never reached and the detail page therefore could not offer."""
    tag = uuid.uuid4().hex[:6]
    client = Client(name=f"Pay{tag} Client", first_name=f"Pay{tag}", last_name="Client",
                    status="active", org_id=org_id)
    db.add(client)
    db.commit()
    made["clients"].append(client.id)

    inv = Invoice(client_id=client.id, status="draft", total=240.0, org_id=org_id)
    db.add(inv)
    db.commit()
    made["invoices"].append(inv.id)
    assert inv.public_token is None, "fixture is meant to start without a token"
    return inv


def test_mints_a_token_for_an_invoice_that_was_never_sent(made):
    db = SessionLocal()
    try:
        inv = _unsent_invoice(db, made)
        out = generate_invoice_token(inv.id, db=db, org_id=inv.org_id)

        assert out["public_token"], "no token minted"
        assert len(out["public_token"]) >= 32, "token is too short to be unguessable"
        assert out["invoice_link"].endswith(f"/pay/{out['public_token']}")
        # Persisted, not just returned — the pay page looks it up by token.
        db.expire_all()
        assert db.get(Invoice, inv.id).public_token == out["public_token"]
    finally:
        db.close()


def test_copying_twice_does_not_rotate_a_link_the_customer_may_hold(made):
    # The expensive mistake. A customer who was emailed the link would find it
    # dead, with nothing on either side explaining why.
    db = SessionLocal()
    try:
        inv = _unsent_invoice(db, made)
        first = generate_invoice_token(inv.id, db=db, org_id=inv.org_id)
        second = generate_invoice_token(inv.id, db=db, org_id=inv.org_id)
        assert second["public_token"] == first["public_token"]
        assert second["invoice_link"] == first["invoice_link"]
    finally:
        db.close()


def test_the_link_uses_the_customer_facing_host_not_the_callers(made):
    # QuoteDetail builds its link from window.location.origin; this one comes
    # from the server so a preview or LAN host cannot leak into a customer's
    # URL. Asserted against the config helper rather than a literal, so a
    # deployment changing APP_BASE_URL does not fail this.
    from config import app_base_url

    db = SessionLocal()
    try:
        inv = _unsent_invoice(db, made)
        out = generate_invoice_token(inv.id, db=db, org_id=inv.org_id)
        assert out["invoice_link"].startswith(app_base_url().rstrip("/") + "/pay/")
        assert "//pay/" not in out["invoice_link"], "a trailing slash doubled up"
    finally:
        db.close()


def test_an_invoice_in_another_org_mints_nothing(made):
    # MT-2. It mints a bearer credential from a path id, which is the shape
    # #1133 found nine of on the properties router with no org filter.
    from fastapi import HTTPException

    db = SessionLocal()
    try:
        if not db.query(Org).filter(Org.id == 1).first():
            db.add(Org(id=1, name="Maine Cleaning Co", slug="maine-cleaning-co"))
            db.commit()
        inv = _unsent_invoice(db, made, org_id=1)

        assert generate_invoice_token(inv.id, db=db, org_id=1)["public_token"]

        with pytest.raises(HTTPException) as caught:
            generate_invoice_token(inv.id, db=db, org_id=2)
        assert caught.value.status_code == 404
    finally:
        db.close()
