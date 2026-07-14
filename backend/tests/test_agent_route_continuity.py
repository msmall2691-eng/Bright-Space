"""Tests for modules/ai/router.py's route_agent() conversation continuity.

Regression covered: Auto-mode routing used to classify every message from
scratch with no memory of which agent had just answered — a short reply
like "yes" or "do it" carries no signal on its own, so a multi-turn
conversation could silently jump to a different agent mid-task. Observed in
production as a user typing the agent's name INTO the message ("yes #6
nova") just to force it back to who they were already talking to.

route_agent() now accepts current_agent_id (whichever agent answered the
previous message) and both (a) folds it into the classifier's system prompt
and (b) uses it as the fallback target when the Anthropic client is
unavailable, so continuity holds even in the no-API-key case these tests
run under.
"""
import os
from unittest.mock import patch

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.ai.router import route_agent, _FALLBACK_AGENT, _FALLBACK_MODEL


def test_fallback_continues_the_last_agent_when_given():
    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}, clear=False):
        result = route_agent("yes, do it", current_agent_id="mia")
        assert result["agent_id"] == "mia"
        assert result["model"] == _FALLBACK_MODEL


def test_fallback_uses_default_agent_with_no_prior_conversation():
    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}, clear=False):
        result = route_agent("what's my revenue this month?")
        assert result["agent_id"] == _FALLBACK_AGENT


def test_system_prompt_carries_continuity_instruction_when_current_agent_given(monkeypatch):
    """When a client IS available, the classifier's system prompt must
    mention the prior agent so it can choose to keep routing there —
    otherwise the continuity fix is a no-op whenever the LLM path runs."""
    captured = {}

    class _FakeContentBlock:
        type = "text"
        text = '{"agent_id": "mia", "model": "sonnet", "reasoning": "continuation"}'

    class _FakeResponse:
        content = [_FakeContentBlock()]

    class _FakeMessages:
        def create(self, model, max_tokens, system, messages):
            captured["system"] = system
            return _FakeResponse()

    class _FakeClient:
        messages = _FakeMessages()

    monkeypatch.setattr("modules.ai.router._anthropic_client", lambda: _FakeClient())

    result = route_agent("yes, go ahead", current_agent_id="mia")

    assert "mia" in captured["system"]
    assert result["agent_id"] == "mia"


def test_system_prompt_omits_continuity_instruction_with_no_prior_agent(monkeypatch):
    captured = {}

    class _FakeContentBlock:
        type = "text"
        text = '{"agent_id": "nova", "model": "sonnet", "reasoning": "new request"}'

    class _FakeResponse:
        content = [_FakeContentBlock()]

    class _FakeMessages:
        def create(self, model, max_tokens, system, messages):
            captured["system"] = system
            return _FakeResponse()

    class _FakeClient:
        messages = _FakeMessages()

    monkeypatch.setattr("modules.ai.router._anthropic_client", lambda: _FakeClient())

    route_agent("what's my revenue this month?")

    assert "PREVIOUS message" not in captured["system"]
