"""@mentions on an internal note notify each tagged teammate.

POST /api/comms/conversations/{id}/notes {body, author, mentions:[user_ids]}:
  - saves an internal note (direction=note, is_internal_note=True) as before, and
  - notifies each mentioned teammate via notify_user_or_sms(category="mentions").
Only real, active, non-client users are notified. The note stays internal.
"""
import uuid
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message, User
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7961, 1, "admin", "active", True
    email = "mention-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_user(db, **over):
    fields = dict(email=f"{uuid.uuid4().hex[:6]}@ex.com", role="cleaner",
                  status="active", full_name="Sarah Sub", org_id=1)
    fields.update(over)
    u = User(**fields)
    db.add(u); db.commit(); db.refresh(u)
    return u.id


def _mk_conv(db):
    client = Client(name="Rental Owner", status="active", org_id=1)
    db.add(client); db.commit(); db.refresh(client)
    conv = Conversation(client_id=client.id, channel="sms", status="open", org_id=1)
    db.add(conv); db.commit(); db.refresh(conv)
    return client.id, conv.id


def _cleanup(conv_id, user_ids, client_id):
    db = SessionLocal()
    db.query(Message).filter(Message.conversation_id == conv_id).delete(synchronize_session=False)
    db.query(Conversation).filter(Conversation.id == conv_id).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(user_ids or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_note_with_mentions_notifies_each_tagged_teammate(api):
    db = SessionLocal()
    client_id, conv_id = _mk_conv(db)
    sub_id = _mk_user(db, full_name="Sarah Sub", role="cleaner")
    office_id = _mk_user(db, full_name="Olive Office", role="manager")
    db.close()
    try:
        with patch("services.crew_notify.notify_user_or_sms", MagicMock(return_value=1)) as notify:
            r = api.post(f"/api/comms/conversations/{conv_id}/notes",
                         json={"body": "@Sarah Sub can you cover this turnover?",
                               "author": "Meg", "mentions": [sub_id, office_id]})
            assert r.status_code == 200, r.text
            body = r.json()
            assert body.get("is_internal_note") is True
            assert body.get("direction") == "note"

            notified = {c.args[0] for c in notify.call_args_list}
            assert notified == {sub_id, office_id}
            for c in notify.call_args_list:
                assert c.kwargs.get("category") == "mentions"
    finally:
        _cleanup(conv_id, [sub_id, office_id], client_id)


def test_mentions_skip_client_and_disabled_users(api):
    db = SessionLocal()
    client_id, conv_id = _mk_conv(db)
    good_id = _mk_user(db, full_name="Active Cleaner", role="cleaner", status="active")
    portal_id = _mk_user(db, full_name="Portal Customer", role="client", status="active")
    gone_id = _mk_user(db, full_name="Left Company", role="cleaner", status="disabled")
    db.close()
    try:
        with patch("services.crew_notify.notify_user_or_sms", MagicMock(return_value=1)) as notify:
            r = api.post(f"/api/comms/conversations/{conv_id}/notes",
                         json={"body": "heads up", "author": "Meg",
                               "mentions": [good_id, portal_id, gone_id]})
            assert r.status_code == 200, r.text
            notified = {c.args[0] for c in notify.call_args_list}
            assert notified == {good_id}          # client + disabled excluded
    finally:
        _cleanup(conv_id, [good_id, portal_id, gone_id], client_id)


def test_note_without_mentions_notifies_nobody(api):
    db = SessionLocal()
    client_id, conv_id = _mk_conv(db)
    db.close()
    try:
        with patch("services.crew_notify.notify_user_or_sms", MagicMock(return_value=1)) as notify:
            r = api.post(f"/api/comms/conversations/{conv_id}/notes",
                         json={"body": "just a note", "author": "Meg"})
            assert r.status_code == 200, r.text
            assert notify.call_count == 0
    finally:
        _cleanup(conv_id, [], client_id)
