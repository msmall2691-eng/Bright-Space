"""AI health endpoint — the admin-only provider status + self-test.

Covers the non-probe path (safe to run without an API key): it reports which
provider is active, whether a key is configured, and the model per tier. The
?probe=1 self-test makes real provider calls, so it isn't exercised here.
"""
import os
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_ai_health_reports_provider_and_models(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    r = client.get("/api/admin/ai-health")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "anthropic"
    assert set(body["models"]) == {"haiku", "sonnet", "opus"}
    assert "available" in body
    assert isinstance(body["anthropic_key_present"], bool)
    assert isinstance(body["gemini_key_present"], bool)
    # Without ?probe=1 it must not make any live calls.
    assert "probes" not in body


def test_ai_health_follows_the_provider_flag(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.6-flash")
    body = client.get("/api/admin/ai-health").json()
    assert body["provider"] == "gemini"
    assert body["models"]["sonnet"] == "gemini-3.6-flash"
