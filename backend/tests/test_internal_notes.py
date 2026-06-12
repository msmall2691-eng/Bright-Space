"""internal_notes split (June 12): operator context can NEVER reach the
public quote page again ("TEST submission ... Please disregard." was live on
QT-2026-0014), and the one-time migration moves legacy notes exactly once.
"""
import pytest

from database.db import SessionLocal, _migrate_quote_notes_to_internal
from database.models import Client, Quote, AppSetting
from modules.quoting.router import _quote_dict, _public_quote_dict, _apply_update


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Internal Notes Test", email="int@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.rollback()
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.query(AppSetting).filter(AppSetting.key == "migrated_quote_notes_to_internal").delete(synchronize_session=False)
    db.commit(); db.close()


def _quote(db, c, **kw):
    kw.setdefault("quote_number", f"QT-INT-{db.query(Quote).count() + 1}")
    q = Quote(client_id=c.id, service_type="residential", address="1 St",
              items=[], subtotal=0, tax_rate=0, tax=0, discount=0, total=0,
              status="draft", **kw)
    db.add(q); db.commit(); db.refresh(q)
    return q


def test_internal_notes_in_app_shape_but_never_public(ctx):
    db, c = ctx
    q = _quote(db, c, notes="Customer-facing scope",
               internal_notes="TEST submission by Claude ... Please disregard.")
    d = _quote_dict(q)
    assert d["internal_notes"].startswith("TEST submission")   # the app sees it

    pub = _public_quote_dict(q, db)
    assert "internal_notes" not in pub                          # the key itself is absent
    assert "Please disregard" not in str(pub)                   # and the text can't leak
    assert pub["notes"] == "Customer-facing scope"              # scope still renders


def test_internal_notes_is_editable(ctx):
    db, c = ctx
    q = _quote(db, c)
    _apply_update(q, {"internal_notes": "gate code 4421"})
    db.commit(); db.refresh(q)
    assert q.internal_notes == "gate code 4421"


def test_notes_migration_runs_exactly_once(ctx):
    db, c = ctx
    legacy = _quote(db, c, notes="From intake: please disregard, test only")

    _migrate_quote_notes_to_internal()
    db.expire_all()
    assert legacy.internal_notes == "From intake: please disregard, test only"
    assert legacy.notes is None                                  # moved, not copied

    # AFTER the split, notes typed by an operator are deliberately
    # customer-facing — a re-run must NOT migrate them.
    fresh = _quote(db, c, notes="Includes kitchen and baths")
    _migrate_quote_notes_to_internal()
    db.expire_all()
    assert fresh.notes == "Includes kitchen and baths"
    assert not fresh.internal_notes


def test_public_dict_brand_color_and_date(ctx):
    db, c = ctx
    q = _quote(db, c)
    pub = _public_quote_dict(q, db)
    assert pub["brand_color"].startswith("#")     # always present for the header band
    assert pub["quote_date"]                      # quote number + date meta
