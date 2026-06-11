"""June 11 incident (item 14): a failing integration_events audit INSERT must
never roll back the caller's transaction, and the reconcile script must catch
column TYPE drift (the audit columns had drifted to json while the model says
String — the deferred INSERT failed at the caller's commit and undid quote
delivery bookkeeping while the customer DID get the email).
"""
from datetime import datetime

import pytest

from database.db import SessionLocal
from database.models import Client, Quote, IntegrationEvent
from utils.integration_log import log_integration_event


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Audit Iso Test", email="audit@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-AUDIT-1", service_type="residential",
              address="1 St", notes="", items=[], subtotal=100, tax_rate=0, tax=0,
              discount=0, total=100, status="draft")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, q
    db.rollback()
    db.query(IntegrationEvent).filter(IntegrationEvent.entity_type == "quote",
                                      IntegrationEvent.entity_id == q.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_failed_audit_write_cannot_roll_back_send_state(ctx):
    """The send-state transition must survive a broken audit insert."""
    db, c, q = ctx
    # The caller's in-flight transaction: the quote was just delivered.
    q.status = "sent"
    q.sent_at = datetime.now()

    # An audit write that is guaranteed to fail at flush (status NOT NULL).
    # Pre-fix this deferred INSERT exploded at the caller's commit below and
    # rolled back the status/sent_at transition with it.
    log_integration_event(db, entity_type="quote", entity_id=q.id,
                          provider="email", action="send", status=None, commit=False)

    db.commit()   # must succeed
    db.refresh(q)
    assert q.status == "sent"
    assert q.sent_at is not None
    # The poisoned audit row itself was discarded, not half-written.
    assert db.query(IntegrationEvent).filter(IntegrationEvent.entity_type == "quote",
                                             IntegrationEvent.entity_id == q.id).count() == 0


def test_healthy_audit_write_still_lands_with_callers_commit(ctx):
    db, c, q = ctx
    q.status = "sent"
    log_integration_event(db, entity_type="quote", entity_id=q.id,
                          provider="email", action="send", status="ok",
                          detail="to audit@example.com", commit=False)
    db.commit()
    row = db.query(IntegrationEvent).filter(IntegrationEvent.entity_type == "quote",
                                            IntegrationEvent.entity_id == q.id).one()
    assert row.status == "ok"
    assert row.request_payload == "to audit@example.com"


def test_reconcile_flags_json_drift_on_string_columns():
    """The incident class: model says String/Text, prod column is json."""
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import sqlalchemy as sa
    from reconcile_prod_schema import _accepted_types

    string_col = sa.Column("request_payload", sa.String)
    accepted = _accepted_types(string_col)
    assert "json" not in accepted and "jsonb" not in accepted   # drift is flagged
    assert {"text", "character varying"} <= accepted            # string family OK

    json_col = sa.Column("custom_fields", sa.JSON)
    assert _accepted_types(json_col) == {"json", "jsonb"}

    bool_col = sa.Column("dispatched", sa.Boolean)
    assert _accepted_types(bool_col) == {"boolean"}             # text would be drift

    dt_col = sa.Column("sent_at", sa.DateTime(timezone=True))
    # tz-ness must NOT be reported as drift (it varies between create_all eras)
    assert "timestamp without time zone" in _accepted_types(dt_col)
