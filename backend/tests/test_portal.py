"""Customer portal: passwordless magic-link sign-in + strictly email-scoped
data. The security-critical assertions here are (a) enumeration-safety on
request-link, (b) a portal session only ever sees its own email's records, and
(c) portal/staff tokens can't cross the boundary."""
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Quote, Invoice, Property
from modules.portal.router import _make_token
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


client = TestClient(app)


def _mk_client(db, email):
    c = Client(name=f"Portal Cust {uuid.uuid4().hex[:5]}", email=email, status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _session_for(email):
    """Mint a real session token by walking the magic → verify exchange."""
    magic = _make_token(email, "portal_magic", timedelta(minutes=10))
    r = client.post("/api/portal/verify", json={"token": magic})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_request_link_is_enumeration_safe():
    # Unknown email and (later) known email must return the identical response.
    unknown = client.post("/api/portal/request-link", json={"email": "nobody-xyz@example.com"})
    assert unknown.status_code == 200
    assert unknown.json().get("ok") is True

    db = SessionLocal()
    c = _mk_client(db, "known-cust@example.com")
    cid = c.id
    db.close()
    try:
        known = client.post("/api/portal/request-link", json={"email": "known-cust@example.com"})
        assert known.status_code == 200
        # Byte-for-byte identical body — nothing distinguishes hit from miss.
        assert known.json() == unknown.json()
    finally:
        db = SessionLocal()
        db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_verify_rejects_bad_and_wrong_type_tokens():
    assert client.post("/api/portal/verify", json={"token": "garbage"}).status_code == 400
    # A session token is not a magic token — can't be exchanged again.
    sess = _make_token("x@example.com", "portal_session", timedelta(days=1))
    assert client.post("/api/portal/verify", json={"token": sess}).status_code == 400


def test_portal_scopes_strictly_to_own_email():
    db = SessionLocal()
    mine = _mk_client(db, "mine@example.com")
    theirs = _mk_client(db, "theirs@example.com")
    mp = Property(client_id=mine.id, name="MP", address="1 Mine St", property_type="residential", active=True, org_id=1)
    tp = Property(client_id=theirs.id, name="TP", address="2 Theirs St", property_type="residential", active=True, org_id=1)
    db.add_all([mp, tp]); db.commit(); db.refresh(mp); db.refresh(tp)
    today = business_today()
    my_job = Job(client_id=mine.id, property_id=mp.id, title="My visit", job_type="residential",
                 scheduled_date=today + timedelta(days=3), status="scheduled", org_id=1)
    their_job = Job(client_id=theirs.id, property_id=tp.id, title="Their visit", job_type="residential",
                    scheduled_date=today + timedelta(days=3), status="scheduled", org_id=1)
    my_q = Quote(client_id=mine.id, quote_number="Q-MINE", title="Mine", total=100, status="sent", org_id=1)
    their_q = Quote(client_id=theirs.id, quote_number="Q-THEIRS", title="Theirs", total=200, status="sent", org_id=1)
    my_inv = Invoice(client_id=mine.id, invoice_number="INV-MINE", total=50, status="sent", org_id=1)
    their_inv = Invoice(client_id=theirs.id, invoice_number="INV-THEIRS", total=60, status="sent", org_id=1)
    db.add_all([my_job, their_job, my_q, their_q, my_inv, their_inv]); db.commit()
    ids = dict(mine=mine.id, theirs=theirs.id, mp=mp.id, tp=tp.id,
               my_job=my_job.id, their_job=their_job.id,
               my_q=my_q.id, their_q=their_q.id, my_inv=my_inv.id, their_inv=their_inv.id)
    db.close()
    try:
        tok = _session_for("mine@example.com")

        me = client.get("/api/portal/me", headers=_auth(tok)).json()
        assert me["email"] == "mine@example.com"

        visits = client.get("/api/portal/visits", headers=_auth(tok)).json()
        vids = [v["id"] for v in visits["upcoming"]]
        assert ids["my_job"] in vids
        assert ids["their_job"] not in vids            # isolation

        quotes = client.get("/api/portal/quotes", headers=_auth(tok)).json()["quotes"]
        qnums = [q["number"] for q in quotes]
        assert "Q-MINE" in qnums and "Q-THEIRS" not in qnums

        invs = client.get("/api/portal/invoices", headers=_auth(tok)).json()["invoices"]
        inums = [i["number"] for i in invs]
        assert "INV-MINE" in inums and "INV-THEIRS" not in inums
    finally:
        db = SessionLocal()
        db.query(Job).filter(Job.id.in_([ids["my_job"], ids["their_job"]])).delete(synchronize_session=False)
        db.query(Quote).filter(Quote.id.in_([ids["my_q"], ids["their_q"]])).delete(synchronize_session=False)
        db.query(Invoice).filter(Invoice.id.in_([ids["my_inv"], ids["their_inv"]])).delete(synchronize_session=False)
        db.query(Property).filter(Property.id.in_([ids["mp"], ids["tp"]])).delete(synchronize_session=False)
        db.query(Client).filter(Client.id.in_([ids["mine"], ids["theirs"]])).delete(synchronize_session=False)
        db.commit(); db.close()


def test_portal_endpoints_require_a_session_token():
    # No token, and a wrong-type (magic) token, are both rejected.
    assert client.get("/api/portal/visits").status_code == 401
    magic = _make_token("mine@example.com", "portal_magic", timedelta(minutes=10))
    assert client.get("/api/portal/visits", headers=_auth(magic)).status_code == 401


def test_portal_token_cannot_reach_staff_endpoints():
    """A portal session token has no user_id, so get_current_user must reject it.
    Uses a real staff-protected endpoint (no dependency override)."""
    tok = _make_token("mine@example.com", "portal_session", timedelta(days=1))
    r = client.get("/api/clients", headers=_auth(tok))
    assert r.status_code in (401, 403)
