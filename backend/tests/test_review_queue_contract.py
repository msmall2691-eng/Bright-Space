"""The review-queue contract: when the inbound filter declines to auto-create a
client, run_inbox_sync must still tag the email so the UI can offer a one-click
"Promote". A filtered-out real customer is recoverable, never silently lost.
"""
import uuid

from database.db import SessionLocal
from modules.gmail.router import run_inbox_sync


def _inbound(**kw):
    base = {
        "id": f"msg-{uuid.uuid4().hex[:8]}",
        "from_email": f"cold_{uuid.uuid4().hex[:8]}@randomsalesco.example",
        "from_name": "Cold Pitch",
        "subject": "partnership opportunity",
        "body": "we help businesses like yours grow your revenue — book a demo",
        "snippet": "",
        "is_read": True,
        "message_id": f"<{uuid.uuid4().hex}@x>",
    }
    base.update(kw)
    return base


def test_skipped_sender_is_tagged_for_review():
    db = SessionLocal()
    try:
        em = _inbound()
        out = run_inbox_sync(db, emails=[em], auto_enrich=True)
        result = out["emails"][0]
        # Not auto-created, but explicitly promotable with a stated reason.
        assert result["is_known_contact"] is False
        assert result["can_convert_to_client"] is True
        assert result["lead_skip_reason"] in {
            "cold_outreach", "no_cleaning_intent", "blocked_sender", "bulk_mail",
        }
    finally:
        db.close()


def test_genuine_inquiry_is_not_flagged_for_review():
    db = SessionLocal()
    try:
        em = _inbound(subject="Need a deep cleaning quote",
                      body="Hi, I'd like a quote for a move-out cleaning of my home.")
        out = run_inbox_sync(db, emails=[em], auto_enrich=True)
        result = out["emails"][0]
        # A real prospect is auto-created, so it doesn't land in the review queue.
        assert result.get("can_convert_to_client") is not True
        assert result["is_known_contact"] is True
    finally:
        # Clean up the auto-created lead via ORM so its conversation / activity /
        # contact-email children cascade-delete too (bulk delete wouldn't).
        from database.models import Client
        for c in db.query(Client).filter(Client.email == em["from_email"].lower()).all():
            db.delete(c)
        db.commit()
        db.close()
