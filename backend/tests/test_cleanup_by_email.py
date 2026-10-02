"""The by-email auto-cleanup must be LOSSLESS and never cross tenants.

cleanup_duplicates_by_email folds placeholder-named clients into the real
client that shares their email. It used to move only a subset of tables and
then delete the placeholder — which cascade-DELETED the placeholder's invoices,
recurring schedules, conversations and contact rows (silent loss of billing and
scheduled work). It now routes through the same lossless body the manual /merge
endpoint uses, so every client-scoped row rides onto the keeper.

It also groups by (org_id, email), so two tenants that share an address are
never merged into each other.
"""
import uuid
from datetime import time

import pytest

from database.db import SessionLocal
from database.models import (
    Client, Invoice, RecurringSchedule, Conversation, ContactPhone,
)
from modules.clients.router import cleanup_duplicates_by_email


def _mk_client(db, name, email, org_id=1):
    c = Client(name=name, email=email, status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _recurring(db, client_id, org_id=1):
    r = RecurringSchedule(
        client_id=client_id, org_id=org_id, job_type="residential",
        title="Weekly clean", address="9 Elm St", frequency="weekly",
        day_of_week=2, start_time=time(9, 0), end_time=time(11, 0),
    )
    db.add(r); db.commit(); db.refresh(r)
    return r


def test_auto_merge_is_lossless(ctx_cleanup):
    """A placeholder's recurring schedule, invoice, conversation and contact
    phone all SURVIVE the merge — re-parented to the keeper, not cascade-deleted
    with the placeholder."""
    db, created = ctx_cleanup
    email = f"lossless-{uuid.uuid4().hex}@x.com"
    keeper = _mk_client(db, "Jane Real", email); created.append(keeper.id)
    placeholder = _mk_client(db, "Unknown", email); created.append(placeholder.id)

    rec = _recurring(db, placeholder.id)
    inv = Invoice(client_id=placeholder.id, org_id=1,
                  invoice_number=f"INV-{uuid.uuid4().hex[:8]}", status="sent", total=250.0)
    conv = Conversation(client_id=placeholder.id, org_id=1, channel="email",
                        subject="Re: booking", status="open")
    phone = ContactPhone(client_id=placeholder.id, phone="+12075551212",
                         phone_tail="2075551212", is_primary=True)
    db.add_all([inv, conv, phone]); db.commit()
    rec_id, inv_id, conv_id = rec.id, inv.id, conv.id

    out = cleanup_duplicates_by_email(dry_run=False, db=db)
    assert any(m["placeholder_id"] == placeholder.id and m["keeper_id"] == keeper.id
               for m in out["merges"]), out

    db.expire_all()
    # Placeholder gone; every one of its records now belongs to the keeper —
    # none silently cascade-deleted.
    assert db.query(Client).filter(Client.id == placeholder.id).first() is None
    assert db.query(RecurringSchedule).filter(RecurringSchedule.id == rec_id).one().client_id == keeper.id
    assert db.query(Invoice).filter(Invoice.id == inv_id).one().client_id == keeper.id
    assert db.query(Conversation).filter(Conversation.id == conv_id).one().client_id == keeper.id
    assert db.query(ContactPhone).filter(ContactPhone.client_id == keeper.id,
                                         ContactPhone.phone == "+12075551212").first() is not None


def test_dry_run_previews_recurring_and_invoices(ctx_cleanup):
    """The preview must count the SAME tables the real merge moves, so it can't
    understate what's at stake (the old preview omitted invoices/recurring)."""
    db, created = ctx_cleanup
    email = f"preview-{uuid.uuid4().hex}@x.com"
    keeper = _mk_client(db, "Sam Real", email); created.append(keeper.id)
    placeholder = _mk_client(db, "n/a", email); created.append(placeholder.id)
    _recurring(db, placeholder.id)
    db.add(Invoice(client_id=placeholder.id, org_id=1,
                   invoice_number=f"INV-{uuid.uuid4().hex[:8]}", status="sent", total=99.0))
    db.commit()

    out = cleanup_duplicates_by_email(dry_run=True, db=db)
    detail = next(m for m in out["merges"] if m["placeholder_id"] == placeholder.id)
    assert out["dry_run"] is True
    assert detail["reassigned"]["recurring"] == 1
    assert detail["reassigned"]["invoices"] == 1
    # And nothing was actually applied.
    db.expire_all()
    assert db.query(Client).filter(Client.id == placeholder.id).first() is not None


def test_auto_merge_never_crosses_orgs(ctx_cleanup):
    """A placeholder in a DIFFERENT org that shares the keeper's email must be
    left completely alone — grouping is per (org_id, email)."""
    db, created = ctx_cleanup
    email = f"tenant-{uuid.uuid4().hex}@x.com"
    keeper = _mk_client(db, "Jane Org1", email, org_id=1); created.append(keeper.id)
    ph1 = _mk_client(db, "Unknown", email, org_id=1); created.append(ph1.id)
    # Same email, different tenant — must never be pulled into org 1's merge.
    foreign = _mk_client(db, "Unknown", email, org_id=2); created.append(foreign.id)
    foreign_rec = _recurring(db, foreign.id, org_id=2)
    foreign_rec_id = foreign_rec.id

    out = cleanup_duplicates_by_email(dry_run=False, db=db)
    # The org-1 pair merged...
    assert any(m["placeholder_id"] == ph1.id for m in out["merges"])
    # ...but the org-2 client and its schedule are untouched.
    assert not any(m["placeholder_id"] == foreign.id or m["keeper_id"] == foreign.id
                   for m in out["merges"])
    db.expire_all()
    assert db.query(Client).filter(Client.id == foreign.id).first() is not None
    assert db.query(RecurringSchedule).filter(
        RecurringSchedule.id == foreign_rec_id).one().client_id == foreign.id


@pytest.fixture
def ctx_cleanup():
    db = SessionLocal()
    created = []
    yield db, created
    db.rollback()
    for cid in created:
        db.query(RecurringSchedule).filter(RecurringSchedule.client_id == cid).delete(synchronize_session=False)
        db.query(Invoice).filter(Invoice.client_id == cid).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.client_id == cid).delete(synchronize_session=False)
        db.query(ContactPhone).filter(ContactPhone.client_id == cid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
    db.commit(); db.close()
