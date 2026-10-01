"""A property's standing (designated) cleaner (migration 120).

Meg can hand one cleaner an Airbnb: set Property.standing_cleaner_id and every
turnover the feed generates is posted as a TARGETED OFFER only that cleaner
sees, grouped for them in My Properties, one-tap claimable. It stays an offer —
everyone on the book is a subcontractor, so the cleaner accepts and the office
approves; nobody is assigned (brightbase-marketplace Rule 0).

What must hold:
- Generation stamps open_for_claims + offer_audience=[standing] + posted_rate on
  a standing property's turnover; a non-standing property's turnover carries none
  of that (created unassigned/unposted, exactly as before).
- The turnover GCal push silently invites the customer when they have an email
  (send_invite=True, send_updates="none" — on their calendar, no email each
  time); no email → the internal event, unchanged.
- GET /api/crew/my-properties groups the cleaner's standing rentals with their
  upcoming turnovers, flags mine vs claimable, and carries NO access details.
- A standing turnover is NOT double-listed on the anonymized open board for its
  own designated cleaner (they get the richer My Properties view instead).
- Setting standing_cleaner_id validates against real cleaners; "" clears it.
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Property, Job, PropertyIcal, ICalEvent, User,
    SubAgreement, SubDocument,
)
from modules.auth.router import get_current_user, current_org_id
from integrations.ical_sync import sync_property
from utils.dates import business_today


# ── iCal generation harness (mirrors test_ical_inactive_gate) ──────────────

@pytest.fixture(autouse=True)
def _stub_ssrf_dns():
    with patch("integrations.ical_sync._assert_public_url", return_value=None):
        yield


def _ics(events):
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN"]
    for uid, checkin, checkout, summary in events:
        lines += [
            "BEGIN:VEVENT", f"UID:{uid}",
            f"DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}",
            f"SUMMARY:{summary}", "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines).encode()


def _patch_feed(ics_bytes):
    mock_cls = MagicMock()
    entered = mock_cls.return_value.__enter__.return_value

    def _get(url, *a, **k):
        resp = MagicMock()
        resp.content = ics_bytes
        resp.raise_for_status = MagicMock()
        return resp

    entered.get.side_effect = _get
    return patch("integrations.ical_sync._httpx.Client", mock_cls)


def _future_booking():
    checkin = date.today() + timedelta(days=10)
    checkout = date.today() + timedelta(days=12)
    return checkout, _ics([("standing-stay@airbnb", checkin, checkout, "Reserved")])


def _seed(db, *, standing_cid=None, client_email="owner@example.com", turnover_rate=None):
    client = Client(name="Rental Owner", email=client_email, status="active", org_id=1)
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="7 Dune Way", address="7 Dune Way",
                    property_type="str", org_id=1, city="Portland", state="ME",
                    house_code="4321", access_notes="Lockbox by the gate",
                    standing_cleaner_id=standing_cid, turnover_rate=turnover_rate)
    db.add(prop); db.commit(); db.refresh(prop)
    url = f"https://example.com/feed-{uuid.uuid4().hex[:6]}.ics"
    db.add(PropertyIcal(property_id=prop.id, url=url, source="airbnb", active=True))
    db.commit(); db.refresh(prop)
    return client, prop, url


def _cleanup(db, prop, client):
    db.query(ICalEvent).filter(ICalEvent.property_id == prop.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.property_id == prop.id).delete(synchronize_session=False)
    db.query(PropertyIcal).filter(PropertyIcal.property_id == prop.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()


# ── Generation: standing property posts a targeted offer ────────────────────

def test_standing_property_turnover_is_a_targeted_offer():
    db = SessionLocal()
    _client, prop, _url = _seed(db, standing_cid="CT-standing-1", turnover_rate=95.0)
    try:
        checkout, ics = _future_booking()
        with _patch_feed(ics), \
             patch("integrations.google_calendar.create_event", return_value=None), \
             patch("services.crew_notify.notify_jobs_posted", MagicMock(return_value=1)) as notify:
            sync_property(db, prop)
        job = db.query(Job).filter_by(property_id=prop.id, scheduled_date=checkout).first()
        assert job is not None
        assert job.open_for_claims is True
        assert (job.offer_audience or []) == ["CT-standing-1"]
        assert job.posted_rate == 95.0
        # cleaner_ids stays empty — offered, never assigned (Rule 0).
        assert (job.cleaner_ids or []) == []
        # The standing cleaner was notified of the posting.
        assert notify.call_count >= 1
    finally:
        _cleanup(db, prop, _client); db.close()


def test_non_standing_property_turnover_is_not_posted():
    db = SessionLocal()
    _client, prop, _url = _seed(db, standing_cid=None)
    try:
        checkout, ics = _future_booking()
        with _patch_feed(ics), \
             patch("integrations.google_calendar.create_event", return_value=None), \
             patch("services.crew_notify.notify_jobs_posted", MagicMock()) as notify:
            sync_property(db, prop)
        job = db.query(Job).filter_by(property_id=prop.id, scheduled_date=checkout).first()
        assert job is not None
        assert not job.open_for_claims
        assert (job.offer_audience or []) == []
        assert job.posted_rate is None
        assert notify.call_count == 0
    finally:
        _cleanup(db, prop, _client); db.close()


# ── GCal: silent customer invite when they have an email ────────────────────

def test_turnover_gcal_silently_invites_customer_with_email():
    db = SessionLocal()
    _client, prop, _url = _seed(db, client_email="guest.owner@example.com")
    try:
        _checkout, ics = _future_booking()
        cap = MagicMock(return_value="evt-123")
        with _patch_feed(ics), \
             patch("integrations.google_calendar.create_event", cap):
            sync_property(db, prop)
        assert cap.call_count >= 1
        kwargs = cap.call_args.kwargs
        # On the customer's calendar (send_invite adds them as attendee) but no
        # email each time (send_updates forced to "none").
        assert kwargs.get("send_invite") is True
        assert kwargs.get("send_updates") == "none"
    finally:
        _cleanup(db, prop, _client); db.close()


def test_turnover_gcal_no_invite_when_customer_has_no_email():
    db = SessionLocal()
    _client, prop, _url = _seed(db, client_email=None)
    try:
        _checkout, ics = _future_booking()
        cap = MagicMock(return_value="evt-456")
        with _patch_feed(ics), \
             patch("integrations.google_calendar.create_event", cap):
            sync_property(db, prop)
        assert cap.call_count >= 1
        kwargs = cap.call_args.kwargs
        # No email → internal, code-bearing event exactly as before.
        assert kwargs.get("send_invite") is False
        assert kwargs.get("send_updates") is None
    finally:
        _cleanup(db, prop, _client); db.close()


# ── Crew view + open-board suppression + validation (TestClient) ────────────

class _Cleaner:
    def __init__(self, uid, cid):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cid


class _Admin:
    id, org_id, role, status, active = 9960, 1, "admin", "active", True
    email = "office@example.com"; full_name = "The Office"; cleaner_id = None


def _vet(uid, org_id=1):
    from services.sub_vetting import CURRENT_AGREEMENT_VERSION
    db = SessionLocal()
    db.query(SubDocument).filter(SubDocument.user_id == uid).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id == uid).delete(synchronize_session=False)
    db.add(SubAgreement(org_id=org_id, user_id=uid, version=CURRENT_AGREEMENT_VERSION,
                        accepted_at=business_today()))
    db.add(SubDocument(org_id=org_id, user_id=uid, kind="w9", status="accepted", data=b"x"))
    db.add(SubDocument(org_id=org_id, user_id=uid, kind="coi", status="accepted", data=b"x",
                       expires_at=business_today() + timedelta(days=365)))
    db.commit(); db.close()


def _as(user, *, vet=False):
    if vet:
        _vet(user.id)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


CID = "CT-mp-owner"
UID = 9971


@pytest.fixture
def world():
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    db.merge(User(id=UID, email=f"mp-{tag}@x.com", full_name="Dana", role="cleaner",
                  cleaner_id=CID, org_id=1, password_hash="x"))
    db.commit(); db.close()
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    _clear()
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id == UID).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id == UID).delete(synchronize_session=False)
    db.query(User).filter(User.id == UID).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_standing_turnover(ids, *, mine=False, days_out=5):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Owner {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"9 Tide {tag}", address=f"9 Tide {tag}", org_id=1,
                 city="Bath", state="ME", property_type="str", house_code="9999",
                 access_notes="Back door", standing_cleaner_id=CID, turnover_rate=90.0)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="str_turnover", title=f"Turnover — {p.name}",
            scheduled_date=business_today() + timedelta(days=days_out),
            start_time=time(10, 0), end_time=time(13, 0),
            cleaner_ids=[CID] if mine else [], status="scheduled", org_id=1,
            open_for_claims=not mine, posted_rate=90.0,
            offer_audience=[CID] if not mine else None)
    db.add(j); db.commit(); db.refresh(j)
    ids["clients"].append(c.id); ids["properties"].append(p.id); ids["jobs"].append(j.id)
    pid, jid = p.id, j.id; db.close()
    return pid, jid


def test_my_properties_groups_turnovers_and_flags_state(world):
    pid, jid = _mk_standing_turnover(world, mine=False)
    _, jid_mine = _mk_standing_turnover(world, mine=True, days_out=6)
    try:
        r = _as(_Cleaner(UID, CID)).get("/api/crew/my-properties")
        assert r.status_code == 200, r.text
        props = r.json()["properties"]
        # Both standing properties for this cleaner are present.
        assert len(props) == 2
        # Each turnover row exposes state but NO access details.
        all_turns = [t for pr in props for t in pr["turnovers"]]
        assert all_turns, "expected turnovers grouped under the properties"
        for t in all_turns:
            assert set(("house_code", "wifi_password", "access_notes")).isdisjoint(t.keys())
        offered = next(t for t in all_turns if t["job_id"] == jid)
        assert offered["claimable"] is True and offered["mine"] is False
        taken = next(t for t in all_turns if t["job_id"] == jid_mine)
        assert taken["mine"] is True and taken["claimable"] is False
    finally:
        _clear()


def test_my_properties_requires_cleaner_role(world):
    r = _as(_Admin()).get("/api/crew/my-properties")
    _clear()
    assert r.status_code in (401, 403)


def test_standing_turnover_hidden_from_open_board_for_its_cleaner(world):
    _pid, jid = _mk_standing_turnover(world, mine=False)
    try:
        day = _as(_Cleaner(UID, CID), vet=True).get("/api/crew/my-day").json()
        open_ids = {j["id"] for j in day.get("open_jobs", [])}
        # Shown in My Properties, not double-listed (stripped) on the open board.
        assert jid not in open_ids
    finally:
        _clear()


def test_setting_standing_cleaner_validates_and_clears(world):
    # A property to edit.
    db = SessionLocal()
    c = Client(name="Val Owner", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="1 Set St", address="1 Set St", org_id=1, property_type="str")
    db.add(p); db.commit(); db.refresh(p)
    world["clients"].append(c.id); world["properties"].append(p.id)
    pid = p.id; db.close()
    try:
        api = _as(_Admin())
        # Unknown cleaner_id → 422.
        assert api.patch(f"/api/properties/{pid}", json={"standing_cleaner_id": "CT-nobody"}).status_code == 422
        # Real cleaner → set.
        r = api.patch(f"/api/properties/{pid}", json={"standing_cleaner_id": CID})
        assert r.status_code == 200, r.text
        assert r.json()["standing_cleaner_id"] == CID
        # "" clears it back to None.
        r2 = api.patch(f"/api/properties/{pid}", json={"standing_cleaner_id": ""})
        assert r2.status_code == 200 and r2.json()["standing_cleaner_id"] is None
    finally:
        _clear()
