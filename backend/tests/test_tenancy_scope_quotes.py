"""Multi-tenancy MT-2: quotes + invoices scoped to the caller's workspace.

Same pattern as the other modules. Also asserts the PUBLIC token endpoints stay
reachable — they authenticate by token, not org, and must NOT be tenant-scoped.
"""
import uuid
from datetime import date
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote, Invoice, LeadIntake

client = TestClient(app)
OTHER_ORG = 99999
_QR_SOURCE = "quote_request"


def _client(db, org_id):
    c = Client(name=f"QOwner {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    return c


def test_other_org_quote_is_invisible_but_public_token_works():
    db = SessionLocal()
    c = _client(db, OTHER_ORG)
    q = Quote(client_id=c.id, quote_number=f"QT-T-{uuid.uuid4().hex[:6]}", title="Other Quote",
              status="sent", total=100, org_id=OTHER_ORG, public_token=uuid.uuid4().hex)
    db.add(q); db.commit(); db.refresh(q)
    try:
        ids = {r["id"] for r in client.get("/api/quotes?limit=500").json()}
        assert q.id not in ids, "cross-tenant quote leaked into the list"
        assert client.get(f"/api/quotes/{q.id}").status_code == 404
        assert client.patch(f"/api/quotes/{q.id}", json={"title": "x"}).status_code == 404
        # PUBLIC token endpoint must still resolve it (token auth, not org).
        assert client.get(f"/api/quotes/public/{q.public_token}").status_code == 200
    finally:
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_other_org_quote_mutations_are_404():
    """Every mutating/admin quote endpoint must refuse a cross-tenant quote by ID.

    These status-transition + delivery endpoints were retrofitted after the
    read/list/patch ones (MT-2) and had been resolving the quote with no org
    filter — a real cross-tenant IDOR (accept/send/decline/convert/permanent-
    delete another workspace's quote). The org check fires in _get_quote_or_404
    before any side effect, so an out-of-org id is a 404 regardless of status.
    """
    db = SessionLocal()
    c = _client(db, OTHER_ORG)
    q = Quote(client_id=c.id, quote_number=f"QT-M-{uuid.uuid4().hex[:6]}", title="Other Quote",
              status="archived", total=100, org_id=OTHER_ORG, public_token=uuid.uuid4().hex)
    db.add(q); db.commit(); db.refresh(q)
    qid = q.id
    try:
        assert client.put(f"/api/quotes/{qid}", json={"title": "x"}).status_code == 404
        assert client.post(f"/api/quotes/{qid}/send", json={}).status_code == 404
        assert client.post(f"/api/quotes/{qid}/generate-token").status_code == 404
        assert client.post(f"/api/quotes/{qid}/accept", json={}).status_code == 404
        assert client.post(f"/api/quotes/{qid}/decline").status_code == 404
        assert client.post(f"/api/quotes/{qid}/convert-to-job", json={}).status_code == 404
        assert client.get(f"/api/quotes/{qid}/delivery-history").status_code == 404
        assert client.delete(f"/api/quotes/{qid}/permanent").status_code == 404
        # It must still be present (nothing above mutated or deleted it).
        db.expire_all()
        still = db.query(Quote).filter(Quote.id == qid).first()
        assert still is not None and still.status == "archived"
    finally:
        db.query(Quote).filter(Quote.id == qid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_other_org_quote_request_is_invisible_and_unwritable():
    """The quote-request inbox (LeadIntake source=quote_request) is org-scoped too:
    another workspace's request must not list, and updating it by id is a 404."""
    db = SessionLocal()
    row = LeadIntake(name=f"QR {uuid.uuid4().hex[:6]}", source=_QR_SOURCE,
                     status="new", org_id=OTHER_ORG)
    db.add(row); db.commit(); db.refresh(row)
    rid = row.id
    try:
        ids = {r["id"] for r in client.get("/api/quotes/requests/").json()}
        assert rid not in ids, "cross-tenant quote request leaked into the list"
        assert client.put(f"/api/quotes/requests/{rid}", json={"status": "reviewed"}).status_code == 404
    finally:
        db.query(LeadIntake).filter(LeadIntake.id == rid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_other_org_invoice_is_invisible():
    db = SessionLocal()
    c = _client(db, OTHER_ORG)
    inv = Invoice(client_id=c.id, invoice_number=f"INV-T-{uuid.uuid4().hex[:6]}",
                  status="draft", total=50, org_id=OTHER_ORG)
    db.add(inv); db.commit(); db.refresh(inv)
    try:
        ids = {r["id"] for r in client.get("/api/invoices?limit=200").json()}
        assert inv.id not in ids, "cross-tenant invoice leaked into the list"
        assert client.get(f"/api/invoices/{inv.id}").status_code == 404
        assert client.delete(f"/api/invoices/{inv.id}").status_code == 404
    finally:
        db.query(Invoice).filter(Invoice.id == inv.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_legacy_null_org_quote_and_invoice_stay_visible():
    db = SessionLocal()
    c = _client(db, None)
    q = Quote(client_id=c.id, quote_number=f"QT-L-{uuid.uuid4().hex[:6]}", title="Legacy",
              status="draft", total=10, org_id=None)
    inv = Invoice(client_id=c.id, invoice_number=f"INV-L-{uuid.uuid4().hex[:6]}",
                  status="draft", total=10, org_id=None)
    db.add_all([q, inv]); db.commit(); db.refresh(q); db.refresh(inv)
    try:
        assert client.get(f"/api/quotes/{q.id}").status_code == 200
        assert client.get(f"/api/invoices/{inv.id}").status_code == 200
    finally:
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Invoice).filter(Invoice.id == inv.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
