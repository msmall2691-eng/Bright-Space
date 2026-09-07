"""Telling the bench a job exists — the SMS half.

Posting a job to the board announced itself by web push and nothing else, and
`notify_jobs_posted` returned 0 before it had even looked at the bench when
VAPID keys were unset. Web push needs the app installed to the home screen AND
notifications allowed — on an iPhone both, in that order — which is a chain an
independent cleaner has no particular reason to have completed. So work was
being posted to people who were never told, silently, and the job sat there.

What is pinned here is mostly RESTRAINT, because a text costs money and
goodwill in a way a push does not:

  * nobody gets both. SMS goes only to the people push could not reach;
  * a person who muted open jobs gets NEITHER. This is the one that needs its
    own test: `notify_user` returns 0 both when it failed and when the user
    opted out, so a fallback keyed on "push returned 0" would text exactly the
    people who asked not to hear from you;
  * one text per person per posting, batch included — twelve houses on a
    changeover Saturday is one message, not twelve;
  * the body is the push body: day, time, town, rate. Never the property name
    or the address. A text is MORE exposed than a push — it sits in a thread
    forever — and the board withholds whose house it is until the job is won;
  * with Twilio unconfigured it does nothing and says so, rather than raising
    into the schedule write it hangs off.
"""
import uuid
from datetime import date

import pytest

from database.db import SessionLocal
from database.models import Client, Job, Property, User
from services import crew_notify

WHEN = date(2026, 3, 12)


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(
        Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(
        Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_sub(ids, *, phone="207-555-0101", prefs=None):
    db = SessionLocal()
    u = User(email=f"sub-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="Dana Sub", org_id=1, active=True, status="active",
             cleaner_id=f"CT-{uuid.uuid4().hex[:6]}", phone=phone,
             notification_prefs=prefs)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id)
    out = (u.id, u.cleaner_id)
    db.close()
    return out


def _mk_job(ids, *, town="Rockport", rate=185.0):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Board {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"Sea View {tag}",
                 address=f"12 Secret Lane {tag}", city=town, state="ME", org_id=1)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title="Turnover", scheduled_date=WHEN, status="scheduled",
            cleaner_ids=[], org_id=1, open_for_claims=True, posted_rate=rate)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    return db, job


class _Sms:
    """Records every text instead of calling Twilio."""

    def __init__(self, *, configured=True, fail=False):
        self._configured = configured
        self._fail = fail
        self.sent = []

    def configured(self):
        return self._configured

    def send_sms(self, *, to, body):
        if self._fail:
            raise RuntimeError("Twilio API error: boom")
        self.sent.append({"to": to, "body": body})
        return {"sid": "SM1", "status": "queued"}


def _wire(monkeypatch, *, cleared, push_returns=0, sms=None):
    """Point the announcement at fakes: a known bench, a known push outcome,
    and a recording SMS client."""
    sms = sms or _Sms()
    monkeypatch.setattr(crew_notify, "_cleared_recipients", lambda db, oid: cleared)

    from services import push_service
    calls = []

    def _notify(user_id, title, body, **kw):
        calls.append({"user_id": user_id, "title": title, "body": body, **kw})
        n = push_returns(user_id) if callable(push_returns) else push_returns
        return n

    monkeypatch.setattr(push_service, "notify_user", _notify)
    from integrations import twilio_client
    monkeypatch.setattr(twilio_client, "configured", sms.configured)
    monkeypatch.setattr(twilio_client, "send_sms", sms.send_sms)
    return sms, calls


# ── The reason this exists ──────────────────────────────────────────────────

def test_a_sub_push_cannot_reach_gets_a_text(ids, monkeypatch):
    uid, cid = _mk_sub(ids)
    db, job = _mk_job(ids)
    sms, pushes = _wire(monkeypatch, cleared=[{"user_id": uid, "cleaner_id": cid}],
                        push_returns=0)
    try:
        sent = crew_notify.notify_jobs_posted(db, [job], org_id=1)
    finally:
        db.close()

    assert len(pushes) == 1, "push is still tried first"
    assert len(sms.sent) == 1
    assert sent == 1
    assert sms.sent[0]["to"] == "+12075550101"


def test_nobody_gets_both(ids, monkeypatch):
    """SMS is a fallback, not a second copy. Texting somebody whose phone just
    buzzed is how a person mutes the channel that matters."""
    reached, missed = _mk_sub(ids), _mk_sub(ids, phone="207-555-0202")
    db, job = _mk_job(ids)
    cleared = [{"user_id": reached[0], "cleaner_id": reached[1]},
               {"user_id": missed[0], "cleaner_id": missed[1]}]
    sms, pushes = _wire(monkeypatch, cleared=cleared,
                        push_returns=lambda uid: 1 if uid == reached[0] else 0)
    try:
        crew_notify.notify_jobs_posted(db, [job], org_id=1)
    finally:
        db.close()

    assert len(pushes) == 2
    assert [s["to"] for s in sms.sent] == ["+12075550202"]


def test_muting_open_jobs_silences_both_channels(ids, monkeypatch):
    """THE case that needs its own test.

    notify_user returns 0 when it failed AND when the user opted out, so a
    fallback keyed on "push returned 0" would text precisely the people who
    turned this off — the worst possible reading of the switch.
    """
    muted = _mk_sub(ids, prefs={"open_jobs": False})
    db, job = _mk_job(ids)
    sms, pushes = _wire(monkeypatch,
                        cleared=[{"user_id": muted[0], "cleaner_id": muted[1]}],
                        push_returns=0)
    try:
        sent = crew_notify.notify_jobs_posted(db, [job], org_id=1)
    finally:
        db.close()

    assert sms.sent == [], "a muted sub must not be texted"
    assert pushes == [], "and must not be pushed either"
    assert sent == 0


def test_another_category_being_off_does_not_mute_this_one(ids, monkeypatch):
    """The opt-out is per category. Turning off the digest is not turning off
    work."""
    uid, cid = _mk_sub(ids, prefs={"digest": False, "job_assignments": False})
    db, job = _mk_job(ids)
    sms, _ = _wire(monkeypatch, cleared=[{"user_id": uid, "cleaner_id": cid}],
                   push_returns=0)
    try:
        crew_notify.notify_jobs_posted(db, [job], org_id=1)
    finally:
        db.close()

    assert len(sms.sent) == 1


# ── What the text may say ───────────────────────────────────────────────────

def test_the_text_never_names_the_house(ids, monkeypatch):
    """The board withholds the property and address until a job is won, and a
    text is more exposed than a push — it stays in the thread."""
    uid, cid = _mk_sub(ids)
    db, job = _mk_job(ids, town="Rockport")
    prop_name = job.property.name
    address = job.property.address
    sms, _ = _wire(monkeypatch, cleared=[{"user_id": uid, "cleaner_id": cid}],
                   push_returns=0)
    try:
        crew_notify.notify_jobs_posted(db, [job], org_id=1)
    finally:
        db.close()

    body = sms.sent[0]["body"]
    assert prop_name not in body and address not in body
    assert "Secret Lane" not in body
    # What it SHOULD carry: when, where roughly, how much, and somewhere to go.
    assert "Rockport" in body and "$185" in body
    assert "/my-day" in body


def test_a_changeover_saturday_is_one_text_not_twelve(ids, monkeypatch):
    """Twelve messages in a row is how somebody turns texts off, and then they
    are off for the job that was already theirs."""
    uid, cid = _mk_sub(ids)
    db, first = _mk_job(ids)
    _, second = _mk_job(ids, town="Camden", rate=140.0)
    _, third = _mk_job(ids, town="Wells", rate=160.0)
    sms, _ = _wire(monkeypatch, cleared=[{"user_id": uid, "cleaner_id": cid}],
                   push_returns=0)
    try:
        crew_notify.notify_jobs_posted(db, [first, second, third], org_id=1)
    finally:
        db.close()

    assert len(sms.sent) == 1
    assert "3 jobs on the board" in sms.sent[0]["body"]


# ── Degrading quietly ───────────────────────────────────────────────────────

def test_with_twilio_unconfigured_it_does_nothing_and_does_not_raise(ids, monkeypatch):
    uid, cid = _mk_sub(ids)
    db, job = _mk_job(ids)
    sms, _ = _wire(monkeypatch, cleared=[{"user_id": uid, "cleaner_id": cid}],
                   push_returns=0, sms=_Sms(configured=False))
    try:
        assert crew_notify.notify_jobs_posted(db, [job], org_id=1) == 0
    finally:
        db.close()
    assert sms.sent == []


def test_a_failed_send_does_not_cost_the_rest_of_the_bench(ids, monkeypatch):
    a, b = _mk_sub(ids), _mk_sub(ids, phone="207-555-0303")
    db, job = _mk_job(ids)
    cleared = [{"user_id": a[0], "cleaner_id": a[1]},
               {"user_id": b[0], "cleaner_id": b[1]}]

    class _Flaky(_Sms):
        def send_sms(self, *, to, body):
            if to == "+12075550101":
                raise RuntimeError("Twilio API error: bad number")
            return super().send_sms(to=to, body=body)

    sms, _ = _wire(monkeypatch, cleared=cleared, push_returns=0, sms=_Flaky())
    try:
        sent = crew_notify.notify_jobs_posted(db, [job], org_id=1)
    finally:
        db.close()

    assert [s["to"] for s in sms.sent] == ["+12075550303"]
    assert sent == 1


def test_a_sub_with_no_number_is_skipped_not_crashed(ids, monkeypatch):
    uid, cid = _mk_sub(ids, phone=None)
    db, job = _mk_job(ids)
    sms, _ = _wire(monkeypatch, cleared=[{"user_id": uid, "cleaner_id": cid}],
                   push_returns=0)
    try:
        assert crew_notify.notify_jobs_posted(db, [job], org_id=1) == 0
    finally:
        db.close()
    assert sms.sent == []
