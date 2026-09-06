"""Recurring Doctor (owner screenshot, Aug 2026): the live list carried a
series titled just "biweekly", duplicate pairs, an ended series still showing,
and paused leftovers. audit_series must name each disease with a suggested
fix and never write anything.

(no_time_set is exercised in production by schema-drifted NULL times; the test
schema enforces the model's NOT NULL so that code path isn't seedable here.)
"""
import uuid
from datetime import time, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, RecurringSchedule, Job
from services.recurring_guards import audit_series
from utils.dates import business_today


@pytest.fixture
def made():
    ids = {"clients": [], "properties": [], "schedules": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id.in_(ids["schedules"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(db, made, name="Health Client"):
    c = Client(name=f"{name} {uuid.uuid4().hex[:5]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    made["clients"].append(c.id)
    return c


def _mk_prop(db, made, client_id):
    p = Property(client_id=client_id, name="1 Health St", address="1 Health St")
    db.add(p); db.commit(); db.refresh(p)
    made["properties"].append(p.id)
    return p


def _mk_sched(db, made, client_id, *, title="Residential Clean — Weekly", active=True,
              property_id=None, days=(1,), end_date=None, start=time(9, 0)):
    s = RecurringSchedule(
        client_id=client_id, job_type="residential", title=title,
        address="1 Health St", frequency="weekly", interval_weeks=1,
        day_of_week=days[0], days_of_week=list(days),
        start_time=start, end_time=time(12, 0),
        active=active, property_id=property_id, series_end_date=end_date,
    )
    db.add(s); db.commit(); db.refresh(s)
    made["schedules"].append(s.id)
    return s


def _mk_upcoming_job(db, made, sched, prop):
    j = Job(client_id=sched.client_id, property_id=prop.id, title="Visit",
            job_type="residential", status="scheduled",
            scheduled_date=business_today() + timedelta(days=3),
            recurring_schedule_id=sched.id)
    db.add(j); db.commit(); db.refresh(j)
    made["jobs"].append(j.id)
    return j


def _issue_for(report, sid):
    return next((i for i in report["issues"] if i["schedule_id"] == sid), None)


def _codes(issue):
    return {p["code"] for p in issue["problems"]} if issue else set()


def test_healthy_series_is_not_listed(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=p.id)
    _mk_upcoming_job(db, made, s, p)
    report = audit_series(db, None)
    assert _issue_for(report, s.id) is None
    assert report["healthy"] >= 1
    db.close()


def test_duplicate_pair_grouped_and_flagged(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    a = _mk_sched(db, made, c.id, property_id=p.id, days=(1, 3))
    b = _mk_sched(db, made, c.id, property_id=p.id, days=(3, 5))  # overlaps on Wed
    report = audit_series(db, None)
    assert sorted([a.id, b.id]) in report["duplicate_groups"]
    assert "duplicate" in _codes(_issue_for(report, a.id))
    assert "duplicate" in _codes(_issue_for(report, b.id))
    db.close()


def test_ended_but_active_and_junk_title(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=p.id, title="biweekly",
                  end_date=business_today() - timedelta(days=7))
    report = audit_series(db, None)
    codes = _codes(_issue_for(report, s.id))
    assert "ended_but_active" in codes
    assert "junk_title" in codes
    # Ended series must NOT read as a live duplicate of anything.
    assert all(s.id not in g for g in report["duplicate_groups"])
    # The rename suggestion leads with the client's actual name.
    prob = next(p_ for p_ in _issue_for(report, s.id)["problems"] if p_["code"] == "junk_title")
    assert c.name.split()[0] in prob["suggestion"]
    db.close()


def test_active_no_upcoming_and_stale_paused(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    stalled = _mk_sched(db, made, c.id, property_id=p.id)              # active, 0 upcoming
    leftover = _mk_sched(db, made, c.id, property_id=p.id, days=(5,), active=False)
    report = audit_series(db, None)
    assert "active_no_upcoming" in _codes(_issue_for(report, stalled.id))
    lo = _issue_for(report, leftover.id)
    assert "stale_paused" in _codes(lo)
    stale = next(p_ for p_ in lo["problems"] if p_["code"] == "stale_paused")
    assert stale["destructive"] is True  # UI must escalate the confirm
    db.close()


def test_missing_property_link_is_an_error_and_carries_the_fix(made):
    """It was `info`, worded as though the only cost were a missing link.

    It is not cosmetic. Job.property_id is NOT NULL and every occurrence copies
    it off the schedule, so a series with no property generates NOTHING: each
    insert trips the constraint and the race-safe handler swallows it as a
    duplicate. The visits already booked run out and no more are made, silently.
    That is an error, and when the client has exactly one property the scan now
    carries it so the fix is one tap instead of a hunt.
    """
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=None)
    _mk_upcoming_job(db, made, s, p)
    report = audit_series(db, None)
    issue = _issue_for(report, s.id)
    assert "no_property" in _codes(issue)
    prob = next(p_ for p_ in issue["problems"] if p_["code"] == "no_property")
    assert prob["severity"] == "error" and prob["destructive"] is False
    assert "can't create visits" in prob["message"]
    assert prob["suggest_property_id"] == p.id
    assert prob["suggest_property_label"] == p.name
    db.close()


def test_a_series_with_no_property_really_does_generate_nothing(made):
    """Why the finding above is an error and not a note.

    Proves the mechanism rather than trusting the label: generation returns 0
    and writes no rows, without raising. That is exactly how three of the
    owner's live series went quiet with nothing telling her — the constraint
    failure is caught by the race-safe handler and logged as a duplicate.
    """
    from modules.recurring.router import generate_jobs

    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=None)

    assert generate_jobs(db, s) == 0
    assert db.query(Job).filter(Job.recurring_schedule_id == s.id).count() == 0

    # Control: the same series WITH the property generates, so the assertion
    # above is about the missing link and not about a fixture that never had
    # any dates to expand in the first place.
    s.property_id = p.id
    db.commit()
    assert generate_jobs(db, s) > 0

    db.query(Job).filter(Job.recurring_schedule_id == s.id).delete(synchronize_session=False)
    db.commit(); db.close()


# ── The shape the duplicate detector cannot see (owner, Sep 2026) ────────────
# Sandra Fox had a live "every 4 weeks Tue" and a paused "every 4 weeks Fri"
# with one stranded visit — the Friday she was moved off. Same client, same
# cadence, different day, so a day-keyed duplicate bucket never matched, and it
# sat there until the owner noticed two of her by eye.

def test_a_paused_series_on_the_day_they_moved_off_is_flagged(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    live = _mk_sched(db, made, c.id, property_id=p.id, days=(1,))
    moved_off = _mk_sched(db, made, c.id, property_id=p.id, days=(4,), active=False)

    report = audit_series(db, None)
    issue = _issue_for(report, moved_off.id)
    assert "reschedule_leftover" in _codes(issue)
    prob = next(x for x in issue["problems"] if x["code"] == "reschedule_leftover")
    assert prob["partners"] == [live.id]
    assert prob["destructive"] is True, "it cancels a real series; the UI must escalate"

    # The running series is the keeper by definition and is never the thing
    # offered for cancelling.
    assert "reschedule_leftover" not in _codes(_issue_for(report, live.id))
    db.close()


def test_a_paused_copy_on_the_same_day_stays_a_duplicate(made):
    """Same day is 'entered twice', a different day is 'they moved'. Two
    different sentences to the office, and a series is never asked about
    under both."""
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    _mk_sched(db, made, c.id, property_id=p.id, days=(1,))
    twin = _mk_sched(db, made, c.id, property_id=p.id, days=(1,), active=False)

    codes = _codes(_issue_for(audit_series(db, None), twin.id))
    assert "duplicate_paused" in codes
    assert "reschedule_leftover" not in codes
    db.close()


def test_a_weekly_and_a_monthly_series_for_one_client_are_left_alone(made):
    """A client can legitimately have a weekly clean and a monthly deep clean.
    Offering to cancel one of those would be worse than saying nothing, which
    is why the key still has to match on frequency and interval."""
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    _mk_sched(db, made, c.id, property_id=p.id, days=(1,))
    monthly = _mk_sched(db, made, c.id, property_id=p.id, days=(4,), active=False)
    monthly.interval_weeks = 4
    db.commit()

    assert "reschedule_leftover" not in _codes(_issue_for(audit_series(db, None), monthly.id))
    db.close()


def test_no_property_is_offered_when_the_client_has_two_houses(made):
    """Only when it is unambiguous. Sending a cleaner to the wrong house is
    worse than making the office pick, so a second property withdraws the
    one-tap fix and leaves the finding (which is still a real error)."""
    db = SessionLocal()
    c = _mk_client(db, made)
    _mk_prop(db, made, c.id)
    _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=None)
    issue = _issue_for(audit_series(db, None), s.id)
    prob = next(p_ for p_ in issue["problems"] if p_["code"] == "no_property")
    assert prob["severity"] == "error"
    assert "suggest_property_id" not in prob, "two houses: the office chooses"
    db.close()



# ── Owner screenshot, Sep 2026: 32 series, 6 healthy, and a list that never
#    shrinks. Two separate bugs in the scan itself, both visible in that shot.


def _cancel(db, sched):
    """Cancel a series the way the app does: active off, cancelled_at stamped."""
    from datetime import datetime
    sched.active = False
    sched.cancelled_at = datetime.utcnow()
    db.commit(); db.refresh(sched)
    return sched


def test_a_cancelled_series_is_not_nagged_about_things_it_will_never_do(made):
    """The screenshot: a CANCELLED series flagged "no start/end time on file —
    visits can't be scheduled at a real time."

    It will never schedule a visit. Setting its time window is busywork the
    scan invented, and busywork in a health check is why the count never
    appeared to go down. Same for a missing property link and a poor title:
    those describe how a series will misbehave WHEN IT GENERATES, and this one
    won't.
    """
    db = SessionLocal()
    c = _mk_client(db, made)
    s = _mk_sched(db, made, c.id, title="biweekly", property_id=None)  # junk title, no property
    before = _codes(_issue_for(audit_series(db, None), s.id))
    assert {"junk_title", "no_property"} <= before, before

    _cancel(db, s)
    issue = _issue_for(audit_series(db, None), s.id)
    after = _codes(issue) if issue else set()
    assert "junk_title" not in after
    assert "no_property" not in after
    db.close()


def test_a_paused_series_is_still_nagged_because_it_can_come_back(made):
    """Paused is not decided. Its problems come back when it does."""
    db = SessionLocal()
    c = _mk_client(db, made)
    s = _mk_sched(db, made, c.id, title="biweekly", property_id=None, active=False)
    codes = _codes(_issue_for(audit_series(db, None), s.id))
    assert {"junk_title", "no_property"} <= codes, codes
    db.close()


def test_an_ended_but_still_active_series_keeps_all_its_findings(made):
    """Half-decided is not decided. `ended_but_active` says the office is about
    to open it anyway, and hiding the rest just means finding them one at a
    time afterwards."""
    db = SessionLocal()
    c = _mk_client(db, made)
    s = _mk_sched(db, made, c.id, title="biweekly", property_id=None,
                  end_date=business_today() - timedelta(days=7))
    codes = _codes(_issue_for(audit_series(db, None), s.id))
    assert {"ended_but_active", "junk_title", "no_property"} <= codes, codes
    db.close()


def test_paused_copies_of_one_series_are_seen_as_duplicates(made):
    """The bigger half of the screenshot: 32 series, most of them the same
    dozen houses.

    Duplicates were being PAUSED rather than cancelled, and pausing takes a row
    out of _is_live — so `_group_live_duplicates` could not see a single one of
    them. Three copies of Bre Lynch's Tuesday clean, and no finding said so.
    """
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    a = _mk_sched(db, made, c.id, property_id=p.id, days=(1, 3), active=False)
    b = _mk_sched(db, made, c.id, property_id=p.id, days=(3, 5), active=False)
    live = _mk_sched(db, made, c.id, property_id=p.id, days=(3,))   # the one still running

    report = audit_series(db, None)
    group = next(g for g in report["paused_duplicate_groups"]
                 if sorted(g["paused"]) == sorted([a.id, b.id]))
    for sid in (a.id, b.id):
        issue = _issue_for(report, sid)
        assert "duplicate_paused" in _codes(issue)
        prob = next(x for x in issue["problems"] if x["code"] == "duplicate_paused")
        assert prob["destructive"] is True
        assert prob["partners"] == [x for x in sorted([a.id, b.id]) if x != sid]

    # The live one anchors the group but is never offered for cancelling —
    # it's the survivor, and cancelling it would take real visits off the
    # calendar.
    assert group["live"] == [live.id]
    assert all(live.id not in g["paused"] for g in report["paused_duplicate_groups"])
    db.close()


def test_a_live_copy_and_a_paused_one_is_still_a_duplicate(made):
    """The shape my first version missed, and the common one.

    After an "all future visits" edit the old series is left behind and a new
    one takes over, so the usual pile is ONE LIVE copy plus paused ones. That
    fell through both detectors: the live grouping needs every member live,
    the paused grouping needed every member paused. Owner screenshot: Sandra
    Fox with two identical "Every 4 weeks Fri 9:00" and Paul Day with two
    "Biweekly Mon 9:00", one of each still running.
    """
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    live = _mk_sched(db, made, c.id, property_id=p.id, days=(3,))
    left_behind = _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)

    report = audit_series(db, None)
    issue = _issue_for(report, left_behind.id)
    prob = next(x for x in issue["problems"] if x["code"] == "duplicate_paused")
    assert prob["has_live_copy"] is True
    assert prob["partners"] == [], "there is no other paused copy to choose between"
    assert "running series" in prob["message"]

    # And the live one gets no such finding — it is the thing being duplicated.
    live_issue = _issue_for(report, live.id)
    assert "duplicate_paused" not in (_codes(live_issue) if live_issue else set())
    db.close()


def test_a_lone_paused_group_says_there_is_a_choice_to_make(made):
    """No live copy means the office picks which one survives, and the wording
    has to say so — that's a different sentence from "cancel the leftover"."""
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    a = _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)
    _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)

    prob = next(x for x in _issue_for(audit_series(db, None), a.id)["problems"]
                if x["code"] == "duplicate_paused")
    assert prob["has_live_copy"] is False
    assert "paused copies" in prob["message"]
    db.close()


def test_a_cancelled_copy_is_not_a_duplicate_to_resolve(made):
    """Somebody already decided about it. A decided row is history, not a
    to-do — and offering to cancel it again is the exact shape of the bug where
    the fix couldn't clear the finding."""
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    a = _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)
    b = _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)
    _cancel(db, b)

    report = audit_series(db, None)
    assert all(b.id not in g["paused"] for g in report["paused_duplicate_groups"])
    # And with only one paused copy left and nothing live, there is no
    # duplicate at all.
    assert all(a.id not in g["paused"] for g in report["paused_duplicate_groups"])
    db.close()


def test_a_paused_duplicate_reads_as_a_duplicate_not_as_a_lone_leftover(made):
    """Three separate "likely a leftover" findings for what is one decision —
    which copy to keep — is three times the work and none of the context."""
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    a = _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)
    b = _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)

    report = audit_series(db, None)
    for sid in (a.id, b.id):
        codes = _codes(_issue_for(report, sid))
        assert "duplicate_paused" in codes
        assert "stale_paused" not in codes, "one finding for one decision"
    db.close()


def test_a_lone_paused_leftover_still_reads_as_one(made):
    """The single-copy case is unchanged — it really is just a leftover."""
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=p.id, days=(3,), active=False)
    assert "stale_paused" in _codes(_issue_for(audit_series(db, None), s.id))
    db.close()
