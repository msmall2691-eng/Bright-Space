"""Inbox triage — classify the automated-email stream + surface it on the board.

The Gmail sync captures automated/bulk mail (SaaS notices, receipts, promos) that
never becomes a Conversation, classifies it (services/inbox_triage), and the Ops
Board shows it: SaaS/billing/security notices reinforce "Systems & Subscriptions",
promotions/social/newsletters fill "Safe to Ignore". Dismiss clears a card off the
board without touching Gmail. These pin: the rules classifier's buckets, the AI
refinement's graceful fallback, Message-ID dedup on capture, the board wiring
(incl. viewer action-stripping), and the org-scoped dismiss endpoint.
"""
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import InboxTriageItem
from modules.auth.router import get_current_user, current_org_id
from services.inbox_triage import classify_email, capture_triage_item, ai_classify_email

_SEVERITIES = {"urgent", "watch", "info", "good", "recurring"}


class _Admin:
    id, org_id, role, status, active = 7411, 1, "admin", "active", True
    email = "triage-admin@example.com"


class _Viewer:
    id, org_id, role, status, active = 7412, 1, "viewer", "active", True
    email = "triage-viewer@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = []
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(InboxTriageItem).filter(InboxTriageItem.id.in_(ids or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seed(ids, *, section, category="other", org_id=1, dismissed=False,
          subject="A notice", vendor="Acme"):
    db = SessionLocal()
    row = InboxTriageItem(
        org_id=org_id, external_id=f"<{uuid.uuid4().hex}@x>",
        from_addr="x@acme.com", from_name="Acme", subject=subject, snippet="…",
        received_at=datetime.now(timezone.utc).replace(tzinfo=None),
        category=category, section=section, vendor=vendor,
        classified_by="rules", is_read=False,
        dismissed_at=(datetime.now(timezone.utc) if dismissed else None),
    )
    db.add(row); db.commit(); db.refresh(row)
    ids.append(row.id); rid = row.id; db.close()
    return rid


# ── Classifier ───────────────────────────────────────────────────────────────

def test_classifier_routes_to_the_right_bucket():
    def cat(em):
        return classify_email(em)["category"]

    # Money / access → Systems.
    assert cat({"from_email": "receipts@stripe.com", "subject": "Your receipt from Acme"}) == "finance"
    assert cat({"from_email": "no-reply@accounts.google.com",
                "subject": "Security alert: new sign-in"}) == "security"
    # An ops tool's non-promotional notice → Systems (saas).
    assert cat({"from_email": "noreply@connecteam.com", "subject": "Your shift schedule updated"}) == "saas"
    # Marketing blast from a tool vendor is still marketing → Safe to Ignore.
    promo = classify_email({"from_email": "news@mail.mailchimp.com", "subject": "50% off this week!",
                            "list_unsubscribe": "<https://unsub/x>", "labels": ["CATEGORY_PROMOTIONS"]})
    assert promo["category"] == "promotions" and promo["section"] == "safe_to_ignore"
    # Social + generic bulk + fallthrough → Safe to Ignore.
    assert classify_email({"from_email": "a@pinterest.com", "subject": "3 new pins",
                           "labels": ["CATEGORY_SOCIAL"]})["section"] == "safe_to_ignore"
    assert cat({"from_email": "hello@x.example", "subject": "book a demo — grow your business"}) == "promotions"
    assert cat({"from_email": "info@obscure.example", "subject": "An update"}) == "other"


def test_classifier_extracts_vendor_and_unsubscribe():
    r = classify_email({"from_email": "news@mail.notion.so", "subject": "What's new",
                        "list_unsubscribe": "<mailto:u@notion.so>, <https://notion.so/unsub?t=1>"})
    assert r["vendor"] == "Notion"                       # ESP subdomain stripped
    assert r["unsubscribe_url"] == "https://notion.so/unsub?t=1"   # http form, not mailto


def test_ai_classify_falls_back_to_rules_without_key():
    # No Anthropic client → identical to the deterministic rules result. Never raises.
    em = {"from_email": "receipts@stripe.com", "subject": "Your receipt"}
    assert ai_classify_email(em, client_ai=None) == classify_email(em)


# ── Capture (dedup) ──────────────────────────────────────────────────────────

def test_capture_classifies_and_dedups_on_message_id():
    db = SessionLocal()
    mid = f"<{uuid.uuid4().hex}@dedup>"
    em = {"from_email": "noreply@connecteam.com", "subject": "Shift updated",
          "message_id": mid, "date": datetime.now(timezone.utc).isoformat(), "is_read": False}
    try:
        assert capture_triage_item(db, 1, em) is True       # first sighting → inserted
        db.commit()
        assert capture_triage_item(db, 1, em) is False      # second sighting → no dup
        db.commit()
        rows = db.query(InboxTriageItem).filter(InboxTriageItem.external_id == mid).all()
        assert len(rows) == 1
        assert rows[0].section == "systems" and rows[0].category == "saas"
    finally:
        db.query(InboxTriageItem).filter(InboxTriageItem.external_id == mid).delete(synchronize_session=False)
        db.commit(); db.close()


# ── Board wiring ─────────────────────────────────────────────────────────────

def test_board_surfaces_triage_and_hides_dismissed(client):
    api, ids = client
    sys_id = _seed(ids, section="systems", category="finance", subject="Invoice #12", vendor="Stripe")
    safe_id = _seed(ids, section="safe_to_ignore", category="promotions", subject="50% off", vendor="Mailchimp")
    hidden_id = _seed(ids, section="safe_to_ignore", category="promotions", dismissed=True)

    board = api.get("/api/dashboard/board").json()
    by_key = {s["key"]: {it["id"] for it in s["items"]} for s in board["sections"]}
    everything = set().union(*by_key.values())

    assert f"triage:{sys_id}" in by_key["systems"]
    assert f"triage:{safe_id}" in by_key["safe_to_ignore"]
    assert f"triage:{hidden_id}" not in everything          # dismissed → hidden

    # Card shape: valid severity + a Dismiss (api) action + an Open-in-Gmail link.
    card = next(it for s in board["sections"] for it in s["items"] if it["id"] == f"triage:{safe_id}")
    assert card["severity"] in _SEVERITIES
    assert any(a["kind"] == "api" for a in card["actions"])          # Dismiss
    assert any(a["kind"] == "link" and "mail.google.com" in a.get("href", "")
               for a in card["actions"])                            # Open in Gmail


def test_viewer_triage_card_drops_the_dismiss_action(client):
    api, ids = client
    rid = _seed(ids, section="safe_to_ignore", category="promotions")
    app.dependency_overrides[get_current_user] = lambda: _Viewer()  # popped by fixture teardown

    board = api.get("/api/dashboard/board").json()
    card = next((it for s in board["sections"] for it in s["items"] if it["id"] == f"triage:{rid}"), None)
    assert card is not None, "viewer should still see the triage card"
    assert all(a["kind"] != "api" for a in card["actions"]), "dismiss must be stripped for viewers"
    assert any(a["kind"] == "link" for a in card["actions"]), "navigation links stay"


# ── Dismiss endpoint ─────────────────────────────────────────────────────────

def test_dismiss_hides_from_list_and_board(client):
    api, ids = client
    rid = _seed(ids, section="safe_to_ignore", category="promotions")

    assert any(i["id"] == rid for i in api.get("/api/inbox/triage").json()["items"])
    assert api.post(f"/api/inbox/triage/{rid}/dismiss").json()["dismissed"] is True

    assert all(i["id"] != rid for i in api.get("/api/inbox/triage").json()["items"])
    board = api.get("/api/dashboard/board").json()
    assert f"triage:{rid}" not in {it["id"] for s in board["sections"] for it in s["items"]}


def test_dismiss_is_org_scoped(client):
    api, ids = client
    other = _seed(ids, section="systems", category="saas", org_id=2)   # a different tenant's row
    assert api.post(f"/api/inbox/triage/{other}/dismiss").status_code == 404


def test_dismiss_all_clears_only_the_named_section(client):
    api, ids = client
    a = _seed(ids, section="safe_to_ignore", category="promotions")
    b = _seed(ids, section="safe_to_ignore", category="social")
    c = _seed(ids, section="systems", category="finance")

    res = api.post("/api/inbox/triage/dismiss-all", params={"section": "safe_to_ignore"}).json()
    assert res["dismissed"] >= 2

    remaining = {i["id"] for i in api.get("/api/inbox/triage").json()["items"]}
    assert a not in remaining and b not in remaining
    assert c in remaining                                   # Systems section untouched
