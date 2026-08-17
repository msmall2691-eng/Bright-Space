"""Crew Ask assistant — grounding and gating.

The security property that matters: door codes, access notes, and WiFi
passwords NEVER enter the prompt — not even the cleaner's own (BB-SEC-08..12:
access details ride only /api/crew/* to the assigned cleaner, never an AI
prompt). The context instead carries a flag so the assistant can point back
to the job card. Also: unconfigured key degrades to a friendly 409, the
Anthropic call is mocked at the client seam, and the question length is
capped.
"""
import uuid
from datetime import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.auth.router import get_current_user, current_org_id
from modules.crew.router import build_ask_context
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id, name="Ask Tester"):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = name
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def world():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Ask {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    pa = Property(client_id=c.id, name=f"A House {tag}", address=f"1 A St {tag}",
                  org_id=1, house_code="1111")
    pb = Property(client_id=c.id, name=f"B House {tag}", address=f"2 B St {tag}",
                  org_id=1, house_code="2222")
    db.add_all([pa, pb]); db.commit(); db.refresh(pa); db.refresh(pb)
    ja = Job(client_id=c.id, property_id=pa.id, job_type="residential", title="A clean",
             scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
             cleaner_ids=["CT-ask-A"], status="scheduled", org_id=1)
    jb = Job(client_id=c.id, property_id=pb.id, job_type="residential", title="B clean",
             scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
             cleaner_ids=["CT-ask-B"], status="scheduled", org_id=1)
    db.add_all([ja, jb]); db.commit(); db.refresh(ja); db.refresh(jb)
    ids = {"jobs": [ja.id, jb.id], "props": [pa.id, pb.id], "client": c.id}
    db.close()
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["props"])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids["client"]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_context_contains_only_own_jobs(world):
    db = SessionLocal()
    ctx = build_ask_context(db, _Cleaner(9901, "CT-ask-A"))
    db.close()
    assert "1111" not in ctx       # door codes never enter the prompt — not even their own
    assert "2222" not in ctx       # nor another cleaner's
    assert "access details are on the job card" in ctx  # flag stands in for it
    assert "A House" in ctx and "B House" not in ctx


def test_unconfigured_key_degrades_friendly(world, monkeypatch):
    monkeypatch.setattr("modules.ai.router._anthropic_client", lambda: None)
    try:
        api = _as(_Cleaner(9902, "CT-ask-A"))
        r = api.post("/api/crew/ask", json={"question": "What's my day?"})
        assert r.status_code == 409
        assert "message the office" in r.json()["detail"]
    finally:
        _clear()


def test_ask_roundtrip_with_mocked_model(world, monkeypatch):
    captured = {}

    class _FakeMessages:
        def create(self, **kw):
            captured.update(kw)
            return SimpleNamespace(content=[SimpleNamespace(type="text", text="Your job is at 9 AM.")])

    monkeypatch.setattr("modules.ai.router._anthropic_client",
                        lambda: SimpleNamespace(messages=_FakeMessages()))
    try:
        api = _as(_Cleaner(9903, "CT-ask-A"))
        r = api.post("/api/crew/ask", json={"question": "When do I start?"})
        assert r.status_code == 200
        assert r.json()["answer"] == "Your job is at 9 AM."
        # The system prompt carries the grounded context (no door codes at
        # all, own or otherwise) and the rules header.
        assert "1111" not in captured["system"] and "2222" not in captured["system"]
        assert "Answer ONLY from the CONTEXT" in captured["system"]

        # Length cap.
        assert api.post("/api/crew/ask", json={"question": "x" * 501}).status_code == 422
    finally:
        _clear()
