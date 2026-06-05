"""Regression test: an Airbnb iCal feed produces a turnover Job AND a Google
Calendar event, end to end.

Guards the chain that has broken twice in production:
  - the DISTINCT-over-JSON crash that stopped all syncing (#169), and
  - a datetime.time being str()'d into '...T10:00:00:00' so Google rejected the
    event (#171 follow-up).

Runs standalone (no pytest needed): `python tests/test_ical_to_gcal.py`.
"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_ical_to_gcal.db")
os.environ.setdefault("JWT_SECRET", "test")

from datetime import date, timedelta

from database.db import engine, SessionLocal
from database.models import Base, Client, Property, Job
import integrations.ical_sync as ics
import integrations.google_calendar as gc


def _future(n):
    return (date.today() + timedelta(days=n)).strftime("%Y%m%d")


_FEED = (
    "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Airbnb//EN\n"
    "BEGIN:VEVENT\n"
    "DTSTART;VALUE=DATE:{ci}\nDTEND;VALUE=DATE:{co}\n"
    "SUMMARY:Reserved\nUID:regression-uid-1@airbnb.com\nDESCRIPTION:Reservation\n"
    "END:VEVENT\nEND:VCALENDAR\n"
)


class _Resp:
    def __init__(self, content):
        self.content = content
    def raise_for_status(self):
        pass


class _Client:
    def __init__(self, *a, **k):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def get(self, url):
        return _Resp(_FEED.format(ci=_future(3), co=_future(6)).encode())


def run():
    Base.metadata.create_all(engine)

    import httpx
    httpx.Client = _Client  # mock the feed fetch

    calls = []
    gc.create_event = lambda job, client, **kw: (calls.append((job, client)) or "evt_%s" % job.get("id"))

    db = SessionLocal()
    c = Client(name="STR Host", email="host@example.com")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Lake House", address="9 Lake Rd",
                 property_type="str", check_out_time="10:00", timezone="America/New_York")
    db.add(p); db.commit(); db.refresh(p)

    res = ics._sync_ical_url(db, p, "http://fake/ical", ical_source_label="airbnb")
    assert res.get("jobs_created") == 1, res

    job = db.query(Job).filter(Job.job_type == "str_turnover").first()
    assert job is not None, "turnover job not created"
    # DTEND date with no off-by-one (RFC 5545).
    assert job.scheduled_date == date.today() + timedelta(days=6), job.scheduled_date
    assert job.gcal_event_id == "evt_%s" % job.id, job.gcal_event_id
    assert len(calls) == 1, "create_event should be called once"

    # The event the push would send must be a valid ISO datetime even though
    # job times are datetime.time objects from the ORM.
    built = gc._build_event(calls[0][0], calls[0][1])
    assert built["start"]["dateTime"].count(":") == 2, built["start"]
    assert "T" in built["start"]["dateTime"], built["start"]

    print("PASS: iCal feed -> turnover job -> valid Google Calendar event")


def run_stale_jobid():
    """A booking whose iCal event still points at a deleted Job (stale job_id)
    must be recreated, not skipped forever ('Synced — no new turnovers')."""
    from database.models import ICalEvent
    Base.metadata.create_all(engine)
    import httpx
    httpx.Client = _Client
    calls = []
    gc.create_event = lambda job, client, **kw: (calls.append(job) or "evt")

    db = SessionLocal()
    c = Client(name="Host2", email="h2@example.com"); db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Pier House", address="74 Central",
                 property_type="str", check_out_time="10:00"); db.add(p); db.commit(); db.refresh(p)
    co = (date.today() + timedelta(days=6))
    ev = ICalEvent(uid="regression-uid-1@airbnb.com", property_id=p.id, summary="Reserved",
                   checkin_date=(date.today() + timedelta(days=3)).isoformat(),
                   checkout_date=co.isoformat(), job_id=999999, event_type="reservation")
    db.add(ev); db.commit()

    res = ics._sync_ical_url(db, p, "http://fake/ical", ical_source_label="airbnb")
    assert res.get("jobs_created") == 1, ("stale job_id not recreated", res)
    db.refresh(ev)
    job = db.query(Job).filter(Job.property_id == p.id, Job.job_type == "str_turnover").first()
    assert job and ev.job_id == job.id, "event not repointed to the new job"
    assert len(calls) == 1, "recreated turnover not pushed to Google"
    print("PASS: stale job_id -> turnover recreated + pushed")


if __name__ == "__main__":
    try:
        run()
        run_stale_jobid()
    finally:
        try:
            os.remove("test_ical_to_gcal.db")
        except OSError:
            pass
