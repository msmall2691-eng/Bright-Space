"""Integration secrets are encrypted at rest in app_settings.

The Square/Connecteam/SMTP/Google-token values used to sit in plaintext (a DB
dump leaked live credentials) while per-user Google tokens were Fernet-encrypted.
These pin the fix: set_setting encrypts, get_setting transparently decrypts,
legacy plaintext still reads (rollout-safe), and the backfill is idempotent.
"""
import pytest

from database.db import SessionLocal
from database.models import AppSetting
from modules.settings.router import get_setting, set_setting
from utils.app_secrets import (
    encode_setting_value, decode_setting_value, encrypt_existing_secrets, SECRET_SETTING_KEYS,
)
from utils.crypto import decrypt_secret

SECRET_KEY = "square_access_token"  # a representative secret key


@pytest.fixture
def clean():
    keys = list(SECRET_SETTING_KEYS) + ["company_name"]

    def _wipe():
        db = SessionLocal()
        db.query(AppSetting).filter(AppSetting.key.in_(keys)).delete(synchronize_session=False)
        db.commit(); db.close()

    _wipe()
    yield
    _wipe()


def test_encode_decode_roundtrip():
    enc = encode_setting_value(SECRET_KEY, "sk-live-123")
    assert enc != "sk-live-123"                             # actually encrypted
    assert decode_setting_value(SECRET_KEY, enc) == "sk-live-123"


def test_decode_plaintext_is_backward_compatible():
    # A legacy plaintext value isn't a Fernet token — return it unchanged, never crash.
    assert decode_setting_value(SECRET_KEY, "legacy-plaintext") == "legacy-plaintext"


def test_non_secret_keys_pass_through():
    assert encode_setting_value("company_name", "Acme Co") == "Acme Co"
    assert decode_setting_value("company_name", "Acme Co") == "Acme Co"


def test_set_setting_encrypts_at_rest_get_setting_reads_through(clean):
    db = SessionLocal()
    try:
        set_setting(db, SECRET_KEY, "tok-abc"); db.commit()
        raw = db.query(AppSetting).filter(AppSetting.key == SECRET_KEY).first().value
        assert raw != "tok-abc"                             # stored ciphertext, not plaintext
        assert decrypt_secret(raw) == "tok-abc"             # ...and it's real Fernet
        assert get_setting(db, SECRET_KEY) == "tok-abc"     # transparent on read
    finally:
        db.close()


def test_backfill_encrypts_legacy_and_is_idempotent(clean):
    db = SessionLocal()
    try:
        db.add(AppSetting(key=SECRET_KEY, value="plain-legacy")); db.commit()
        assert encrypt_existing_secrets(db) == 1
        raw = db.query(AppSetting).filter(AppSetting.key == SECRET_KEY).first().value
        assert raw != "plain-legacy" and decrypt_secret(raw) == "plain-legacy"
        assert encrypt_existing_secrets(db) == 0            # idempotent — nothing left plaintext
        assert get_setting(db, SECRET_KEY) == "plain-legacy"
    finally:
        db.close()
