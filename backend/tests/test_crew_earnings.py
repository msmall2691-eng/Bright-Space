"""BB-PAY-01: a subcontractor can see their own payout ledger.

The ledger existed only on the office side — a sub could set up where their
money goes (/api/crew/me/payouts) but never see what they had coming.
GET /api/crew/me/earnings reads their OWN rows (scoped by user_id) and returns
a light list plus two totals. Per-job amounts only; nothing is derived per hour
(Rule 0). Void lines and other subs' rows never appear.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import User, SubPayout
from modules.crew.router import my_earnings


@pytest.fixture
def ctx():
    db = SessionLocal()
    made = {"users": [], "payouts": []}

    def cleaner():
        cid = f"crew-{uuid.uuid4().hex[:6]}"
        u = User(email=f"{cid}@example.com", role="cleaner", cleaner_id=cid, org_id=1)
        db.add(u); db.commit(); db.refresh(u)
        made["users"].append(u.id)
        return u

    def payout(u, amount, status, job_id=None):
        p = SubPayout(org_id=1, user_id=u.id, cleaner_id=u.cleaner_id,
                      job_id=job_id, amount=amount, status=status)
        db.add(p); db.commit(); db.refresh(p)
        made["payouts"].append(p.id)
        return p

    yield db, cleaner, payout
    db.rollback()
    db.query(SubPayout).filter(SubPayout.id.in_(made["payouts"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_earnings_totals_and_lines_for_my_own_payouts(ctx):
    db, cleaner, payout = ctx
    me = cleaner()
    payout(me, 100.0, "due")
    payout(me, 50.0, "sent")
    payout(me, 200.0, "paid")
    payout(me, 999.0, "void")           # cancelled — must not appear or count

    out = my_earnings(db=db, org_id=1, current_user=me)
    assert out["paid"] == 200.0
    assert out["pending"] == 150.0      # due + sent
    assert out["count"] == 3            # void excluded
    statuses = {l["status"] for l in out["lines"]}
    assert "void" not in statuses


def test_i_never_see_another_subs_amounts(ctx):
    db, cleaner, payout = ctx
    me = cleaner()
    other = cleaner()
    payout(me, 100.0, "due")
    payout(other, 500.0, "due")         # someone else's money

    out = my_earnings(db=db, org_id=1, current_user=me)
    assert out["count"] == 1
    assert out["pending"] == 100.0
    assert all(l["amount"] != 500.0 for l in out["lines"])


def test_a_sub_with_no_payouts_sees_zeroes(ctx):
    db, cleaner, payout = ctx
    me = cleaner()
    out = my_earnings(db=db, org_id=1, current_user=me)
    assert out == {"lines": [], "paid": 0, "pending": 0, "count": 0}
