"""The mobile "Today" view needs day-of operational details on each visit and a
way to scope to one cleaner. This locks in:
- visit_to_dict enriches client.phone + property house_code/access/parking/site
  contact (so the card doesn't need extra round-trips).
- GET /api/visits?cleaner_id=X returns only visits whose cleaner_ids include X.
"""
import pytest
from datetime import date, time

from database.db import SessionLocal
from database.models import Visit, Job, Client, Property
from modules.scheduling.visits_router import visit_to_dict, get_visits


@pytest.fixture
def visit_ctx():
    db = SessionLocal()
    c = Client(name="Today Test", phone="+12075551234", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="4 Red Barn Circle", address="4 Red Barn Circle, Portland ME",
                 property_type="str", active=True, house_code="4251",
                 access_notes="Side door, lockbox", parking_notes="Driveway only",
                 site_contact_name="Host", site_contact_phone="+12075559999",
                 check_out_time="10:00")
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Turnover", job_type="str_turnover",
            scheduled_date=date.today(), start_time=time(10, 0), end_time=time(13, 0),
            status="scheduled")
    db.add(j); db.commit(); db.refresh(j)
    yield db, c, p, j
    db.query(Visit).filter(Visit.job_id == j.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_visit_dict_carries_day_of_details(visit_ctx):
    db, c, p, j = visit_ctx
    v = Visit(job_id=j.id, scheduled_date=date.today(), start_time=time(10, 0),
              end_time=time(13, 0), status="scheduled", cleaner_ids=[])
    db.add(v); db.commit(); db.refresh(v)
    d = visit_to_dict(v, job=j, client=c, property_obj=p)
    assert d["client"]["phone"] == "+12075551234"
    assert d["property"]["house_code"] == "4251"
    assert d["property"]["access_notes"] == "Side door, lockbox"
    assert d["property"]["parking_notes"] == "Driveway only"
    assert d["property"]["site_contact_phone"] == "+12075559999"
    assert d["property"]["check_out_time"] == "10:00"


class _Admin:
    role = "admin"


class _Viewer:
    role = "viewer"


def test_cleaner_id_filter_scopes_visits(visit_ctx):
    db, c, p, j = visit_ctx
    mine = Visit(job_id=j.id, scheduled_date=date.today(), start_time=time(10, 0),
                 end_time=time(13, 0), status="scheduled", cleaner_ids=[7])
    others = Visit(job_id=j.id, scheduled_date=date.today(), start_time=time(14, 0),
                   end_time=time(16, 0), status="scheduled", cleaner_ids=[9])
    db.add(mine); db.add(others); db.commit()
    today = str(date.today())
    out = get_visits(scheduled_date_from=today, scheduled_date_to=today,
                     cleaner_id="7", db=db, current_user=_Admin())
    ids = {item["id"] for item in out["items"]}
    assert mine.id in ids and others.id not in ids
    assert out["total"] == len(out["items"])


def test_cleaner_filter_applies_before_pagination(visit_ctx):
    """A cleaner's match beyond the first page is still found and counted —
    the predicate must run before limit/offset, not after."""
    db, c, p, j = visit_ctx
    # Interleave so the target cleaner's visits aren't all in page one.
    made = []
    for i in range(6):
        cleaner = 7 if i % 2 == 0 else 9  # three each, interleaved by time
        v = Visit(job_id=j.id, scheduled_date=date.today(),
                  start_time=time(8 + i, 0), end_time=time(9 + i, 0),
                  status="scheduled", cleaner_ids=[cleaner])
        db.add(v); made.append(v)
    db.commit()
    today = str(date.today())
    out = get_visits(scheduled_date_from=today, scheduled_date_to=today,
                     cleaner_id="7", limit=2, offset=0, db=db, current_user=_Admin())
    assert out["total"] == 3              # all three matches counted, not just page 1
    assert len(out["items"]) == 2         # page size honored
    assert all(7 in (i["cleaner_ids"] or []) for i in out["items"])


def test_secrets_hidden_from_non_admin(visit_ctx):
    db, c, p, j = visit_ctx
    v = Visit(job_id=j.id, scheduled_date=date.today(), start_time=time(10, 0),
              end_time=time(13, 0), status="scheduled", cleaner_ids=[])
    db.add(v); db.commit()
    today = str(date.today())
    pick = lambda role: next(i for i in get_visits(
        scheduled_date_from=today, scheduled_date_to=today, db=db, current_user=role
    )["items"] if i["id"] == v.id)
    admin = pick(_Admin())
    viewer = pick(_Viewer())
    assert admin["property"].get("house_code") == "4251"
    assert "house_code" not in viewer["property"]
    assert viewer["client"].get("phone") is None
    assert admin["client"].get("phone")
