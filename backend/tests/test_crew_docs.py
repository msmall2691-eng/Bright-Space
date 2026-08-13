"""Crew training/docs library (crew_docs, crew app Phase 5).

The visibility rule under test: office drafts (published=False) NEVER reach
a cleaner's phone — /api/crew/docs is published-only, pinned first. Office
CRUD is admin/manager (viewer reads, cleaner has no office access at all),
input is clamped (title required, category coerced into the fixed
vocabulary, body capped) rather than rejected.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import CrewDoc
from modules.auth.router import get_current_user, current_org_id


class _User:
    def __init__(self, uid, role, cleaner_id=None):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, role, "active", True
        self.email = f"{role}-{uid}@example.com"
        self.full_name = f"{role.title()} {uid}"
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def cleanup():
    made = []
    yield made
    db = SessionLocal()
    if made:
        db.query(CrewDoc).filter(CrewDoc.id.in_(made)).delete(synchronize_session=False)
        db.commit()
    db.close()


def test_office_crud_and_crew_sees_published_only(cleanup):
    tag = uuid.uuid4().hex[:6]
    try:
        office = _as(_User(9980, "admin"))
        # Create: one published+pinned, one draft. Junk category coerces.
        r1 = office.post("/api/crew-docs", json={
            "title": f"Bathroom standard {tag}", "body": "Top to bottom.\nMirrors last.",
            "category": "trainingzzz", "pinned": True})
        assert r1.status_code == 200, r1.text
        d1 = r1.json(); cleanup.append(d1["id"])
        assert d1["category"] == "other"          # unknown coerced, not rejected
        r2 = office.post("/api/crew-docs", json={
            "title": f"Draft policy {tag}", "body": "wip", "published": False})
        d2 = r2.json(); cleanup.append(d2["id"])

        # Office list shows both (drafts included).
        ids = {d["id"] for d in office.get("/api/crew-docs").json()}
        assert {d1["id"], d2["id"]} <= ids

        # Edit: retitle + recategorize + unpin.
        r = office.patch(f"/api/crew-docs/{d1['id']}", json={"category": "training", "pinned": False})
        assert r.status_code == 200 and r.json()["category"] == "training"
        _clear()

        # Crew feed: published only — the draft never appears.
        crew = _as(_User(9981, "cleaner", "CT-doc-1"))
        feed = crew.get("/api/crew/docs").json()
        feed_ids = {d["id"] for d in feed}
        assert d1["id"] in feed_ids and d2["id"] not in feed_ids
        _clear()

        # Publish the draft → it appears.
        office = _as(_User(9980, "admin"))
        office.patch(f"/api/crew-docs/{d2['id']}", json={"published": True})
        _clear()
        crew = _as(_User(9981, "cleaner", "CT-doc-1"))
        assert d2["id"] in {d["id"] for d in crew.get("/api/crew/docs").json()}
        _clear()

        # Delete.
        office = _as(_User(9980, "admin"))
        assert office.delete(f"/api/crew-docs/{d1['id']}").status_code == 200
        assert d1["id"] not in {d["id"] for d in office.get("/api/crew-docs").json()}
    finally:
        _clear()


def test_pinned_docs_sort_first_for_crew(cleanup):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    a = CrewDoc(org_id=1, title=f"Old pinned {tag}", body="x", category="policy",
                pinned=True, published=True)
    b = CrewDoc(org_id=1, title=f"New unpinned {tag}", body="y", category="policy",
                pinned=False, published=True)
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    cleanup.extend([a.id, b.id]); db.close()
    try:
        crew = _as(_User(9982, "cleaner", "CT-doc-2"))
        order = [d["id"] for d in crew.get("/api/crew/docs").json() if d["id"] in (a.id, b.id)]
        assert order == [a.id, b.id]              # pinned beats freshness
    finally:
        _clear()


def test_role_gates(cleanup):
    try:
        # Cleaner can't touch the office endpoints.
        crew = _as(_User(9983, "cleaner", "CT-doc-3"))
        assert crew.get("/api/crew-docs").status_code == 403
        assert crew.post("/api/crew-docs", json={"title": "nope"}).status_code == 403
        _clear()
        # Viewer reads the office list but can't write.
        viewer = _as(_User(9984, "viewer"))
        assert viewer.get("/api/crew-docs").status_code == 200
        assert viewer.post("/api/crew-docs", json={"title": "nope"}).status_code == 403
        _clear()
        # Office roles don't use the crew feed.
        office = _as(_User(9985, "admin"))
        assert office.get("/api/crew/docs").status_code == 403
        # Empty title clamps to a 422, not a 500.
        assert office.post("/api/crew-docs", json={"title": "   "}).status_code == 422
        # A non-http(s) link never becomes a tap target on a phone.
        assert office.post("/api/crew-docs", json={
            "title": "Bad link", "url": "javascript:alert(1)"}).status_code == 422
    finally:
        _clear()


def test_link_doc_roundtrip(cleanup):
    tag = uuid.uuid4().hex[:6]
    try:
        office = _as(_User(9986, "admin"))
        r = office.post("/api/crew-docs", json={
            "title": f"Oven cleaner how-to {tag}", "url": "https://example.com/video",
            "category": "products"})
        assert r.status_code == 200 and r.json()["url"] == "https://example.com/video"
        cleanup.append(r.json()["id"])
        _clear()
        crew = _as(_User(9987, "cleaner", "CT-doc-4"))
        mine = [d for d in crew.get("/api/crew/docs").json() if d["id"] == cleanup[-1]]
        assert mine and mine[0]["url"] == "https://example.com/video"
    finally:
        _clear()
