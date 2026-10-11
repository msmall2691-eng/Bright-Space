"""Facebook / Instagram Lead Ads intake.

The endpoint is PUBLIC — Meta cannot send our API key — so most of what is
pinned here is refusal: no app secret means reject, a bad signature means
reject, a signature computed over re-serialized JSON means reject. An
unauthenticated POST that we accept is an unlimited supply of fake leads in
the owner's inbox, and it would look exactly like real business.

The rest is the thing that makes the feature worth having: a Meta lead form's
answers land on the Requests page through the SAME canonical intake path as
the website form, so dedup, the estimate and the source filter need no
special case.
"""
import hashlib
import hmac
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake
from integrations import facebook_leads as fb
from modules.intake.normalize import normalize_source

client = TestClient(app)

SECRET = "test-app-secret"
URL = "/api/intake/facebook"

# Every leadgen id and email below is unique per RUN.
#
# Not hygiene — a correctness requirement for the assertions themselves. The
# dev database persists between runs, and `fb:<leadgen_id>` is a UNIQUE column,
# so a fixed id makes the second run of a test dedup onto the row the FIRST run
# created. The idempotency-key assertion then reads a row written by
# known-good code and passes no matter what the code under test now does. It
# did exactly that: dropping the key entirely survived mutation testing.
RUN = uuid.uuid4().hex[:8]


def uid(label: str) -> str:
    return f"{label}-{RUN}"


def mail(label: str) -> str:
    return f"{label}-{RUN}@example.com"


# The phone has to be unique per run AND per test, for the same reason the
# email does, and it is the one that actually bit — twice.
#
# Intake dedup matches on EITHER contact, so a shared number merges leads
# together: first across runs (a fixed number found a row an earlier run of
# the suite had left behind), then within one run (three tests sharing one
# number chained onto each other — and dedup silences the owner alert, so a
# test asserting on that alert read an empty dict). One number per label.
def phone(label: str) -> str:
    h = int(hashlib.sha256(f"{label}-{RUN}".encode()).hexdigest(), 16)
    return f"+1207{h % 10_000_000:07d}"




def _delivery(leadgen_id="LEAD1", form_id="FORM1", field="leadgen"):
    return {"object": "page", "entry": [{
        "id": "PAGE1", "time": 1,
        "changes": [{"field": field, "value": {
            "leadgen_id": leadgen_id, "page_id": "PAGE1",
            "form_id": form_id, "created_time": 1,
        }}],
    }]}


def _signed(payload: dict):
    """Exact bytes + the header Meta would send for them."""
    raw = json.dumps(payload).encode()
    sig = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return raw, {"x-hub-signature-256": f"sha256={sig}"}


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("FACEBOOK_APP_SECRET", SECRET)
    monkeypatch.setenv("FACEBOOK_VERIFY_TOKEN", "hunter2")
    monkeypatch.setenv("FACEBOOK_PAGE_TOKEN", "page-token")
    return monkeypatch


# ── the endpoint is public, so refusal is the whole security story ──────────

def test_the_path_is_public_exactly_not_by_prefix():
    # A prefix entry would also open anything later named with this stem.
    import auth as auth_mw
    assert URL in auth_mw._PUBLIC_EXACT
    assert not any(URL.startswith(p) and p != URL for p in auth_mw._PUBLIC_PREFIXES)


def test_unconfigured_rejects_rather_than_accepts(monkeypatch):
    monkeypatch.delenv("FACEBOOK_APP_SECRET", raising=False)
    raw, headers = _signed(_delivery())
    r = client.post(URL, content=raw, headers=headers)
    assert r.status_code == 503, r.text


def test_a_forged_delivery_is_rejected(configured):
    raw = json.dumps(_delivery()).encode()
    r = client.post(URL, content=raw, headers={"x-hub-signature-256": "sha256=" + "0" * 64})
    assert r.status_code == 403


def test_an_unsigned_delivery_is_rejected(configured):
    raw = json.dumps(_delivery()).encode()
    assert client.post(URL, content=raw).status_code == 403


def test_signature_is_checked_over_the_raw_bytes(configured):
    """The digest must cover what arrived, not a re-encoding of it.

    Verifying against `json.dumps(parsed)` passes every test written with a
    canonical body and then fails on every real delivery, because Meta's key
    order and spacing are not Python's. Signing a body that differs only in
    whitespace must fail.
    """
    payload = _delivery()
    raw = json.dumps(payload, separators=(",", ":")).encode()
    other = json.dumps(payload, indent=2).encode()  # same object, different bytes
    assert raw != other
    sig = hmac.new(SECRET.encode(), other, hashlib.sha256).hexdigest()
    r = client.post(URL, content=raw, headers={"x-hub-signature-256": f"sha256={sig}"})
    assert r.status_code == 403


def test_signature_algorithm_prefix_must_be_sha256(configured):
    raw = json.dumps(_delivery()).encode()
    digest = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    # Right digest, wrong (or absent) algorithm label.
    assert client.post(URL, content=raw,
                       headers={"x-hub-signature-256": f"sha1={digest}"}).status_code == 403
    assert client.post(URL, content=raw,
                       headers={"x-hub-signature-256": digest}).status_code == 403


def test_an_oversized_body_is_refused_before_it_is_buffered(configured):
    """The body is read into memory BEFORE the signature can reject it.

    So on a public endpoint the cap, not the HMAC, is what stops a stranger
    who doesn't know the app secret from choosing how much memory a worker
    holds. The rate limiter counts requests, not bytes, and nothing else in
    the app caps a body.
    """
    from modules.intake.router import _MAX_WEBHOOK_BODY_BYTES
    huge = b'{"padding":"' + b'x' * (_MAX_WEBHOOK_BODY_BYTES + 1024) + b'"}'
    # Correctly signed, so this is the SIZE being refused and not the HMAC.
    sig = hmac.new(SECRET.encode(), huge, hashlib.sha256).hexdigest()
    r = client.post(URL, content=huge, headers={"x-hub-signature-256": f"sha256={sig}"})
    assert r.status_code == 413, r.status_code


def test_a_lying_content_length_does_not_get_past_the_cap(configured):
    """Content-Length is the caller's claim, so the stream is counted too.

    Checking only the header would let a chunked upload — which sends no
    length at all — walk straight through the guard.
    """
    from modules.intake.router import _MAX_WEBHOOK_BODY_BYTES
    huge = b"x" * (_MAX_WEBHOOK_BODY_BYTES + 1024)

    def chunked():
        # An iterator body makes httpx send Transfer-Encoding: chunked, with
        # no Content-Length for the header check to catch.
        yield huge

    r = client.post(URL, content=chunked(),
                    headers={"x-hub-signature-256": "sha256=" + "0" * 64})
    assert r.status_code == 413, r.status_code


def test_an_ordinary_delivery_is_not_caught_by_the_cap(configured):
    # The other half: a cap set too low would refuse real leads, and every
    # other test here posts a tiny body that could never prove otherwise.
    from modules.intake.router import _MAX_WEBHOOK_BODY_BYTES
    assert len(json.dumps(_delivery()).encode()) < _MAX_WEBHOOK_BODY_BYTES
    raw, headers = _signed(_delivery(field="feed"))
    assert client.post(URL, content=raw, headers=headers).status_code == 200


def test_verify_signature_is_false_without_a_secret(monkeypatch):
    monkeypatch.delenv("FACEBOOK_APP_SECRET", raising=False)
    raw = b"{}"
    # Even a digest over the empty secret must not pass when nothing is set.
    sig = hmac.new(b"", raw, hashlib.sha256).hexdigest()
    assert fb.verify_signature(raw, f"sha256={sig}") is False


# ── the subscribe handshake ─────────────────────────────────────────────────

def test_handshake_echoes_the_challenge_as_plain_text(configured):
    r = client.get(URL, params={"hub.mode": "subscribe",
                               "hub.verify_token": "hunter2",
                               "hub.challenge": "1158201444"})
    assert r.status_code == 200
    # Meta compares the body byte for byte; JSON quotes would fail it.
    assert r.text == "1158201444"


def test_handshake_rejects_a_wrong_token(configured):
    r = client.get(URL, params={"hub.mode": "subscribe",
                               "hub.verify_token": "wrong",
                               "hub.challenge": "x"})
    assert r.status_code == 403


def test_handshake_refuses_when_unconfigured(monkeypatch):
    monkeypatch.delenv("FACEBOOK_VERIFY_TOKEN", raising=False)
    r = client.get(URL, params={"hub.mode": "subscribe",
                               "hub.verify_token": "", "hub.challenge": "x"})
    assert r.status_code == 503


# ── Meta's payload shape ────────────────────────────────────────────────────

def test_only_leadgen_changes_are_acted_on():
    assert fb.iter_leadgen_ids(_delivery()) == [("LEAD1", "FORM1")]
    # A page subscribed to several fields delivers the others here too.
    assert fb.iter_leadgen_ids(_delivery(field="feed")) == []
    assert fb.iter_leadgen_ids({}) == []
    assert fb.iter_leadgen_ids({"entry": [{"changes": [{"field": "leadgen", "value": {}}]}]}) == []


def test_a_batched_delivery_yields_every_lead():
    # Meta batches; handling only entry[0].changes[0] loses the rest silently.
    payload = {"entry": [
        {"changes": [{"field": "leadgen", "value": {"leadgen_id": "A", "form_id": "F"}},
                     {"field": "leadgen", "value": {"leadgen_id": "B", "form_id": "F"}}]},
        {"changes": [{"field": "leadgen", "value": {"leadgen_id": "C", "form_id": "G"}}]},
    ]}
    assert [i for i, _ in fb.iter_leadgen_ids(payload)] == ["A", "B", "C"]


# ── field mapping ───────────────────────────────────────────────────────────

def _fd(**pairs):
    return [{"name": k, "values": [v]} for k, v in pairs.items()]


def test_standard_questions_map_onto_intake_fields():
    out = fb.map_lead_fields(_fd(
        full_name="Anna Sweet", email="anna@example.com", phone_number="+12075550111",
        street_address="12 Pine St", city="Portland", state="ME", zip_code="04101",
    ))
    assert out["name"] == "Anna Sweet"
    assert out["email"] == "anna@example.com"
    assert out["phone"] == "+12075550111"
    assert out["address"] == "12 Pine St"
    assert out["city"] == "Portland"
    assert out["zip_code"] == "04101"


def test_a_split_name_is_joined():
    out = fb.map_lead_fields(_fd(first_name="Anna", last_name="Sweet"))
    assert out["name"] == "Anna Sweet"


def test_full_name_wins_over_a_split_name():
    out = fb.map_lead_fields(
        _fd(first_name="A", last_name="S") + _fd(full_name="Anna Sweet"))
    assert out["name"] == "Anna Sweet"


def test_the_first_answer_wins_for_an_aliased_field():
    out = fb.map_lead_fields([
        {"name": "email", "values": ["real@example.com"]},
        {"name": "work_email", "values": ["work@example.com"]},
    ])
    assert out["email"] == "real@example.com"


def test_custom_questions_are_kept_twice_over():
    """Readable on the card AND structured — a cleaning form's custom question
    ("how many bedrooms") is usually the useful one, and dropping it would
    make the lead arrive emptier than the ad that paid for it."""
    out = fb.map_lead_fields(_fd(full_name="Anna", how_many_bedrooms="3",
                                 pets_in_home="Two cats"))
    assert "How many bedrooms: 3" in out["message"]
    assert "Pets in home: Two cats" in out["message"]
    assert out["custom_fields"]["facebook_answers"] == {
        "how_many_bedrooms": "3", "pets_in_home": "Two cats"}


def test_a_service_question_steers_the_canonical_type():
    from modules.intake.normalize import canonical_service_type
    out = fb.map_lead_fields(_fd(full_name="A", what_type_of_property="Commercial office"))
    assert canonical_service_type(out["service_key"]) == "commercial"
    # ...and the operator still reads the raw answer.
    assert "Commercial office" in out["message"]


def test_blank_answers_are_dropped_not_stored_as_empty():
    out = fb.map_lead_fields([
        {"name": "email", "values": [""]},
        {"name": "phone_number", "values": []},
        {"name": "", "values": ["x"]},
        {"name": "full_name", "values": ["Anna"]},
    ])
    assert "email" not in out and "phone" not in out
    assert out["name"] == "Anna"


def test_mapping_survives_junk():
    assert fb.map_lead_fields(None) == {}
    assert fb.map_lead_fields(["not a dict"]) == {}


# ── the whole path: a Meta lead becomes a Request ───────────────────────────

LEAD = {"id": "LEAD1", "created_time": "2026-10-10T12:00:00+0000", "field_data": _fd(
    full_name="Facebook Tester", email=mail("fbtester"),
    phone_number=phone("lead"), city="Portland", how_many_bedrooms="3")}


def _row(intake_id):
    """Read back the row the endpoint says it wrote, BY ID.

    Not by email: dedup can merge this submission onto an existing lead and
    keep that lead's contact fields, so a lookup by the email we sent can come
    back empty on a row that was written perfectly well.
    """
    db = SessionLocal()
    try:
        return db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
    finally:
        db.close()


def test_a_lead_form_submission_becomes_a_request(configured):
    configured.setattr(fb, "fetch_lead", lambda _id: LEAD)
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADNEW")))
    r = client.post(URL, content=raw, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["leads"] == 1

    row = _row(r.json()["intake_ids"][0])
    assert row is not None
    # Normalized source, so the Requests filter and the funnel's by-source row
    # both find it without a special case.
    assert row.source == "facebook"
    assert row.name == "Facebook Tester"
    assert "How many bedrooms: 3" in (row.message or "")


def test_a_redelivery_does_not_create_a_second_lead(configured):
    """Meta redelivers; the leadgen id is the idempotency key.

    The stored key is asserted directly and NOT just the row count, because
    two posts inside one test also fall inside the 5-minute contact-dedup
    window — so "only one row" would pass with the key dropped entirely, and
    the retry Meta actually sends an hour later would land a duplicate on the
    owner with nothing failing here.
    """
    configured.setattr(fb, "fetch_lead", lambda _id: dict(
        LEAD, field_data=_fd(full_name="Dup Tester", email=mail("duptester"))))
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADDUP")))

    r1 = client.post(URL, content=raw, headers=headers)
    assert r1.status_code == 200
    first = _row(r1.json()["intake_ids"][0])
    assert first.idempotency_key == f"fb:{uid('LEADDUP')}"
    r2 = client.post(URL, content=raw, headers=headers)
    assert r2.status_code == 200
    assert r2.json()["intake_ids"] == [first.id]


def test_a_lead_merged_into_a_recent_request_still_records_its_meta_id(configured):
    """The key has to land on the row we merged INTO.

    `upsert_lead`'s contact dedup collapses a submission onto any request from
    the same email or phone in the last five minutes — and it used not to copy
    the caller's idempotency key across. So a Facebook lead arriving just after
    a website enquiry from the same person was deduped and its leadgen id
    recorded nowhere: the key short-circuit had nothing to find, and Meta's
    redelivery an hour later (it retries for hours on a lost response) opened a
    SECOND request. The key exists to prevent exactly that.
    """
    sent_email = mail("mergetester")
    # A website enquiry lands first, carrying no key of its own.
    first = client.post("/api/intake/submit", json={
        "name": "Merge Tester", "email": sent_email, "phone": phone("merge"),
    })
    assert first.status_code == 201, first.text

    configured.setattr(fb, "fetch_lead", lambda _id: dict(
        LEAD, field_data=_fd(full_name="Merge Tester", email=sent_email)))
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADMERGE")))
    r = client.post(URL, content=raw, headers=headers)
    assert r.status_code == 200, r.text

    merged = _row(r.json()["intake_ids"][0])
    assert merged.id == first.json()["intake_id"], "expected the contact-dedup path"
    assert merged.idempotency_key == f"fb:{uid('LEADMERGE')}", \
        "the merged row has no record of the Meta lead — a redelivery will duplicate it"


def test_adopting_a_key_never_overwrites_one_the_row_already_has(configured):
    """The other half. A row that carries its own key keeps it — overwriting
    would break the FIRST caller's dedup to fix the second's, and the column
    is UNIQUE so there can only be one."""
    sent_email = mail("keeptester")
    own_key = uid("WEBOWN")
    first = client.post("/api/intake/submit", json={
        "name": "Keep Tester", "email": sent_email, "phone": phone("keep"),
        "idempotency_key": own_key,
    })
    assert first.status_code == 201, first.text

    configured.setattr(fb, "fetch_lead", lambda _id: dict(
        LEAD, field_data=_fd(full_name="Keep Tester", email=sent_email)))
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADKEEP")))
    r = client.post(URL, content=raw, headers=headers)
    assert r.status_code == 200

    merged = _row(r.json()["intake_ids"][0])
    assert merged.idempotency_key == own_key


def test_the_blocking_work_does_not_run_on_the_event_loop(configured):
    """A Graph fetch can wait out its 10s timeout, and this route must be
    `async` to read the raw body for the HMAC — so doing the work inline would
    stall the uvicorn worker and stop it serving unrelated API traffic.

    Asserted by recording the thread the fetch runs on: it must not be the one
    running the event loop.
    """
    import asyncio
    import threading

    seen = {}

    def slow_fetch(_id):
        seen["thread"] = threading.get_ident()
        try:
            asyncio.get_running_loop()
            seen["on_loop"] = True
        except RuntimeError:
            seen["on_loop"] = False
        return dict(LEAD, field_data=_fd(full_name="Thread Tester",
                                         email=mail("threadtester")))

    configured.setattr(fb, "fetch_lead", slow_fetch)
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADTHREAD")))
    assert client.post(URL, content=raw, headers=headers).status_code == 200
    assert seen["on_loop"] is False, \
        "the Graph fetch ran on the event loop — a slow Meta response wedges the worker"


def test_a_fetch_failure_asks_meta_to_retry_rather_than_losing_the_lead(configured):
    """503, not 200. Meta retries a non-2xx for hours; a 200 here would
    discard a lead the business paid for, politely and permanently."""
    configured.setattr(fb, "fetch_lead", lambda _id: None)
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADFAIL")))
    assert client.post(URL, content=raw, headers=headers).status_code == 503


def _capture_owner_alerts(monkeypatch):
    """Capture the real owner SMS/email the endpoint sends.

    Stubs the SENDERS, not `_alert_owner_new_request`, so the alert body is
    built by the code under test. Stubbing the helper instead was how the
    service-label assertion below first came to measure nothing: the test
    re-implemented the expression and passed with the router reverted.
    """
    sent = {}
    from services import owner_alerts

    def sms(db, body, **kw):
        sent["sms"] = body
        return True

    def email(db, subject=None, lines=None, **kw):
        sent["subject"] = subject
        sent["lines"] = [str(x) for x in (lines or []) if x]
        return True

    monkeypatch.setattr(owner_alerts, "send_owner_sms", sms)
    monkeypatch.setattr(owner_alerts, "send_owner_email", email)
    return sent


def test_the_owner_is_texted_and_emailed_about_a_facebook_lead(configured):
    """A Facebook lead that only web-pushes is a lead she may never see — push
    is the one channel she may not have enabled on her phone, which is the
    reason the website form got SMS + email in the first place."""
    sent = _capture_owner_alerts(configured)
    configured.setattr(fb, "fetch_lead", lambda _id: dict(
        LEAD, field_data=_fd(full_name="Alert Tester", email=mail("alerttester"))))

    raw, headers = _signed(_delivery(leadgen_id=uid("LEADALERT")))
    assert client.post(URL, content=raw, headers=headers).status_code == 200
    assert "Alert Tester" in sent.get("sms", "")
    assert "Alert Tester" in (sent.get("subject") or "")


def test_the_owner_alert_names_the_service_that_was_asked_for(configured):
    """The alert says the RAW service, not the canonical bucket it maps to.

    IntakeData keeps the canonical value in `service_type` ("residential") and
    the raw one in `requested_service` ("deep clean"). Reading `service_type`
    would text her the bucket where the website form texts her the service —
    a quiet regression on the busiest path in the app.
    """
    sent = _capture_owner_alerts(configured)
    configured.setattr(fb, "fetch_lead", lambda _id: dict(LEAD, field_data=_fd(
        full_name="Service Tester", email=mail("servicetester"),
        what_service_do_you_need="Deep clean")))

    raw, headers = _signed(_delivery(leadgen_id=uid("LEADSVC")))
    assert client.post(URL, content=raw, headers=headers).status_code == 200
    assert "Deep clean" in sent["sms"], sent["sms"]
    assert "Residential" not in sent["sms"], sent["sms"]


def test_the_website_forms_alert_still_names_its_service(configured):
    """Guards the OTHER branch of the same line.

    `_alert_owner_new_request` is now shared, and reads
    `requested_service or service_type` — the second half is what the website
    form (an IntakeSubmit, which has no `requested_service`) relies on.
    Nothing in the suite covered that text before this, so the mutation that
    drops the fallback and silently sends the owner "your cleaning" on every
    website lead passed everything.
    """
    sent = _capture_owner_alerts(configured)
    r = client.post("/api/intake/submit", json={
        "name": "Website Tester", "email": mail("websitetester"),
        "phone": phone("websvc"), "service_type": "deep-clean",
        "idempotency_key": uid("WEBSVC"),
    })
    assert r.status_code == 201, r.text
    assert "Deep clean" in sent["sms"], sent["sms"]


def test_a_change_we_do_not_handle_is_a_quiet_success(configured):
    # Returning non-2xx here would make Meta retry a page edit forever.
    raw, headers = _signed(_delivery(field="feed"))
    r = client.post(URL, content=raw, headers=headers)
    assert r.status_code == 200
    assert r.json()["leads"] == 0


def test_a_lead_with_no_way_to_reach_anybody_is_skipped(configured):
    configured.setattr(fb, "fetch_lead", lambda _id: {"id": "x", "field_data": _fd(
        how_did_you_hear="An ad")})
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADEMPTY")))
    r = client.post(URL, content=raw, headers=headers)
    assert r.status_code == 200
    assert r.json()["leads"] == 0


class _FakeResponse:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _FakeHttpx:
    """Stands in for the `httpx` module inside facebook_leads.

    The HTTP layer is stubbed rather than `fetch_lead` itself, so the real
    fetch — including everything it logs — runs. Stubbing `fetch_lead` was how
    the PII assertion below first came to measure nothing: the mutation that
    logged the whole lead body survived, because the function holding the
    mutated line had been replaced by a lambda.
    """

    def __init__(self, payload, status=200):
        self.payload, self.status, self.last_url, self.last_params = payload, status, None, None

    def Client(self, *a, **kw):  # noqa: N802 — mirrors httpx.Client
        outer = self

        class _Ctx:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *exc):
                return False

            def get(self_inner, url, params=None, **kwargs):
                outer.last_url, outer.last_params = url, params
                return _FakeResponse(outer.payload, outer.status)

        return _Ctx()


def test_the_customers_details_are_never_logged(configured, caplog):
    """`field_data` is the customer's name, phone and email. Identifiers are
    fine to log; answers are not (BB-SEC: PII stays out of logs).

    Exercises the REAL fetch_lead against a stubbed transport — see _FakeHttpx.
    """
    fake = _FakeHttpx(dict(LEAD, field_data=_fd(
        full_name="Quiet Tester", email=mail("quiet"), phone_number="+12075550123")))
    configured.setattr(fb, "httpx", fake)
    raw, headers = _signed(_delivery(leadgen_id=uid("LEADQUIET")))
    with caplog.at_level("DEBUG"):
        assert client.post(URL, content=raw, headers=headers).status_code == 200
    text = caplog.text
    assert mail("quiet") not in text
    assert "+12075550123" not in text
    assert "Quiet Tester" not in text
    # The access token is a credential; it must not reach a log either.
    assert "page-token" not in text


def test_the_fetch_calls_the_graph_lead_node_with_the_page_token(configured):
    """Pins the request the integration actually makes: version-prefixed lead
    node, token as a param, field_data asked for by name. A wrong URL here is
    invisible in every other test, because they all stub the fetch."""
    fake = _FakeHttpx(LEAD)
    configured.setattr(fb, "httpx", fake)
    configured.setenv("FACEBOOK_GRAPH_VERSION", "v99.0")

    assert fb.fetch_lead("LEADXYZ") == LEAD
    assert fake.last_url == "https://graph.facebook.com/v99.0/LEADXYZ"
    assert fake.last_params["access_token"] == "page-token"
    assert "field_data" in fake.last_params["fields"]


def test_a_graph_error_is_a_failure_not_an_empty_lead(configured):
    """A non-200 must return None so the caller 503s and Meta retries. Reading
    `.json()` off an error body would hand back a lead with no fields, which
    the router would then skip — losing the lead permanently."""
    configured.setattr(fb, "httpx", _FakeHttpx({"error": {"message": "bad token"}}, status=400))
    assert fb.fetch_lead("LEADERR") is None


def test_a_200_without_field_data_is_a_failure_too(configured):
    configured.setattr(fb, "httpx", _FakeHttpx({"id": "LEADX"}))
    assert fb.fetch_lead("LEADX") is None


def test_no_page_token_means_no_fetch_attempt(configured):
    configured.delenv("FACEBOOK_PAGE_TOKEN", raising=False)
    fake = _FakeHttpx(LEAD)
    configured.setattr(fb, "httpx", fake)
    assert fb.fetch_lead("LEADNOTOK") is None
    assert fake.last_url is None, "fetched without a token — that call cannot succeed"


# ── source normalization ────────────────────────────────────────────────────

def test_meta_source_spellings_collapse_to_one():
    # An Instagram placement is delivered through the same Page webhook, so
    # splitting them would fragment the funnel over a placement.
    for spelling in ("facebook", "Facebook", "FB", "Meta", "instagram", "IG",
                     "facebook lead ads", "Facebook Ads"):
        assert normalize_source(spelling) == "facebook", spelling
