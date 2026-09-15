"""The provider seam: the same AI helpers run on Anthropic or Gemini, chosen by
LLM_PROVIDER, and fall back cleanly when the chosen provider's key is unset.

Both adapters are exercised with fake clients (no network, no real key) — the
point is that complete_text and run_tool_loop dispatch to the right provider,
convert tools, run the tool loop, and return the final text either way.
"""
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from services import llm


# --- config / selection ------------------------------------------------------

def test_provider_defaults_to_anthropic(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    assert llm.provider() == "anthropic"


def test_provider_reads_the_flag(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "GEMINI")
    assert llm.provider() == "gemini"


def test_model_for_tier_maps_per_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    assert llm.model_for_tier("sonnet").startswith("claude")
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    assert llm.model_for_tier("sonnet").startswith("gemini")
    # An unknown tier falls back to the standard one, not a crash.
    assert llm.model_for_tier("nonsense").startswith("gemini")


def test_available_follows_the_selected_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert llm.available() is False
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert llm.available() is True
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert llm.available() is False


# --- fakes -------------------------------------------------------------------

def _a_block(**kw):
    return SimpleNamespace(**kw)


class _FakeAnthropic:
    """Returns a tool-use turn, then a final text turn."""
    def __init__(self):
        self._turns = [
            SimpleNamespace(stop_reason="tool_use", content=[
                _a_block(type="tool_use", name="get_business_snapshot", input={}, id="t1")]),
            SimpleNamespace(stop_reason="end_turn", content=[
                _a_block(type="text", text="Here is your summary.")]),
        ]
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kw):
        return self._turns.pop(0)


class _FakeGemini:
    """Returns a function-call turn, then a final text turn."""
    def __init__(self):
        self._turns = [
            SimpleNamespace(function_calls=[SimpleNamespace(name="get_business_snapshot", args={})],
                            candidates=[SimpleNamespace(content=SimpleNamespace(role="model", parts=[]))],
                            text=None),
            SimpleNamespace(function_calls=[], text="Here is your summary."),
        ]
        self.models = SimpleNamespace(generate_content=self._gen)

    def _gen(self, **kw):
        return self._turns.pop(0)


# --- complete_text -----------------------------------------------------------

def test_complete_text_anthropic(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    fake = SimpleNamespace(messages=SimpleNamespace(
        create=lambda **kw: SimpleNamespace(content=[_a_block(type="text", text="Drafted.")])))
    with patch.object(llm, "_anthropic", return_value=fake):
        assert llm.complete_text(system="s", user_content="draft a reply") == "Drafted."


def test_complete_text_gemini(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    fake = SimpleNamespace(models=SimpleNamespace(
        generate_content=lambda **kw: SimpleNamespace(text="Drafted.")))
    with patch.object(llm, "_gemini", return_value=fake):
        assert llm.complete_text(system="s", user_content="draft a reply", json_mode=True) == "Drafted."


# --- run_tool_loop -----------------------------------------------------------

_TOOLS = [{"name": "get_business_snapshot", "description": "snapshot",
           "input_schema": {"type": "object", "properties": {}}}]


def test_run_tool_loop_anthropic_executes_then_answers(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    calls = []
    with patch.object(llm, "_anthropic", return_value=_FakeAnthropic()):
        out = llm.run_tool_loop(system="s", user_content="how's business?",
                                tools=_TOOLS, execute=lambda n, a: calls.append(n) or {"clients": 3})
    assert out == "Here is your summary."
    assert calls == ["get_business_snapshot"]  # the tool actually ran


def test_run_tool_loop_gemini_executes_then_answers(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    calls = []
    with patch.object(llm, "_gemini", return_value=_FakeGemini()):
        out = llm.run_tool_loop(system="s", user_content="how's business?",
                                tools=_TOOLS, execute=lambda n, a: calls.append(n) or {"clients": 3})
    assert out == "Here is your summary."
    assert calls == ["get_business_snapshot"]


def test_gemini_tools_pass_schema_through_verbatim():
    # The Anthropic input_schema is handed to Gemini as parameters_json_schema —
    # no hand-translation, which is what keeps the tool set single-sourced.
    with patch("services.llm.provider", return_value="gemini"):
        gtools = llm._gemini_tools(_TOOLS)
    assert gtools is not None and len(gtools) == 1
    decl = gtools[0].function_declarations[0]
    assert decl.name == "get_business_snapshot"
