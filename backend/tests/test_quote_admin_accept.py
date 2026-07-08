"""Admin accept parity (July-2026 audit item 2): POST /quotes/{id}/accept must
run the SAME side effects as the public accept link — convert to a job when a
property is linked, advance the opportunity to 'won', and notify the owner —
instead of the old stub that only flipped the status."""
import pytest
from unittest.mock import patch

from database.db import SessionLocal
from database.models import Client, Property, Quote, Job, Opportunity
from modules.quoting.router import accept_quote, AdminAcceptRequest


def _owner_patches():
    return (
        patch("integrations.email._load_smtp_creds", return_value={"from_email": "owner@biz.com"}),
        patch("integrations.email.send_email", return_value={"ok": True}),
    )


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Admin Accept", email="cust@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    opp = Opportunity(client_id=c.id, title="Deal", stage="quoted", amount=100)
    db.add(opp); db.commit(); db.refresh(opp)
    made = {"client": c, "opp": opp, "props": [], "quotes": []}
    yield db, made
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _make_quote(db, made, *, with_property, number):
    c, opp = made["client"], made["opp"]
    prop_id = None
    if with_property:
        p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
        db.add(p); db.commit(); db.refresh(p)
        made["props"].append(p)
        prop_id = p.id
    q = Quote(client_id=c.id, opportunity_id=opp.id, property_id=prop_id,
              quote_number=number, title="T", service_type="residential",
              address="1 St", notes="", items=[{"name": "Clean", "qty": 1, "unit_price": 100}],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100, status="sent")
    db.add(q); db.commit(); db.refresh(q)
    made["quotes"].append(q)
    return q


def test_admin_accept_with_property_converts_and_notifies(ctx):
    db, made = ctx
    q = _make_quote(db, made, with_property=True, number="QT-ADM-1")
    p1, p2 = _owner_patches()
    with p1, p2 as send:
        out = accept_quote(q.id, AdminAcceptRequest(notify_customer=True), db=db)
    db.refresh(q)
    # Auto-convert on accept: a job exists and the quote is 'converted'.
    assert db.query(Job).filter(Job.quote_id == q.id).count() == 1
    assert q.status == "converted"
    # Opportunity advanced to won (via the conversion path).
    db.refresh(made["opp"])
    assert made["opp"].stage == "won"
    assert send.called  # owner notified


def test_admin_accept_without_property_still_wins_opportunity(ctx):
    db, made = ctx
    q = _make_quote(db, made, with_property=False, number="QT-ADM-2")
    p1, p2 = _owner_patches()
    with p1, p2 as send:
        accept_quote(q.id, AdminAcceptRequest(notify_customer=False), db=db)
    db.refresh(q)
    # No property → stays 'accepted' (needs scheduling), no job created…
    assert q.status == "accepted"
    assert db.query(Job).filter(Job.quote_id == q.id).count() == 0
    # …but the deal is still marked won so pipeline metrics don't undercount.
    db.refresh(made["opp"])
    assert made["opp"].stage == "won"
    # notify_customer=False still notifies the owner.
    assert send.called


def test_admin_accept_can_skip_customer_receipt(ctx):
    db, made = ctx
    q = _make_quote(db, made, with_property=False, number="QT-ADM-3")
    q.accepted_by_email = "cust@example.com"
    db.commit()
    p1, p2 = _owner_patches()
    with p1, p2 as send:
        accept_quote(q.id, AdminAcceptRequest(notify_customer=False), db=db)
    recipients = [(call.kwargs.get("to") or (call.args[0] if call.args else None)) for call in send.call_args_list]
    # Owner is notified; the customer receipt is skipped.
    assert "owner@biz.com" in recipients
    assert "cust@example.com" not in recipients
