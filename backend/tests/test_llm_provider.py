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


def test_gemini_defaults_are_a_current_model():
    # Regression guard: the gemini-2.5-* ids were retired for new API keys
    # (a 404 in prod). The built-in default for every tier must be a current,
    # non-2.5 gemini id so a fresh deploy works before any env override.
    for tier in ("haiku", "sonnet", "opus"):
        model = llm._GEMINI_TIERS[tier]
        assert model.startswith("gemini-") and "-2.5-" not in model, model


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


# --- stream_tool_loop (the live Workspace chat) ------------------------------

def _events(gen):
    return list(gen)


class _FakeAnthropicStream:
    """A messages.stream(...) context manager: one tool-use turn, then a final
    text turn. Yields delta + block-start events, get_final_message() gives the
    turn's stop_reason/content."""
    def __init__(self, turns):
        self._turns = turns

    def __call__(self, **kw):
        self._cur = self._turns.pop(0)
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self._cur["events"])

    def get_final_message(self):
        return SimpleNamespace(stop_reason=self._cur["stop_reason"],
                               content=self._cur["content"])


def test_stream_tool_loop_anthropic_events_and_execution(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    delta = SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(text="Hi "))
    start = SimpleNamespace(type="content_block_start",
                            content_block=SimpleNamespace(type="tool_use", name="get_business_snapshot"))
    turns = [
        {"events": [start],
         "stop_reason": "tool_use",
         "content": [SimpleNamespace(type="tool_use", name="get_business_snapshot", input={}, id="t1")]},
        {"events": [delta, SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(text="there."))],
         "stop_reason": "end_turn", "content": []},
    ]
    stream = _FakeAnthropicStream(turns)
    fake = SimpleNamespace(messages=SimpleNamespace(stream=stream))
    calls = []
    with patch.object(llm, "_anthropic", return_value=fake):
        evs = _events(llm.stream_tool_loop(
            system="s", messages=[{"role": "user", "content": "hi"}], tools=_TOOLS,
            execute=lambda n, a: calls.append(n) or {"clients": 3}))
    kinds = [e["type"] for e in evs]
    assert kinds[0] == "tool_call" and kinds[-1] == "final"
    assert {"type": "tool_result", "name": "get_business_snapshot", "preview": '{"clients": 3}'} in evs
    assert evs[-1]["text"] == "Hi there."
    assert evs[-1]["tools_used"] == ["get_business_snapshot"]
    assert calls == ["get_business_snapshot"]


def _gchunk(text=None, calls=None):
    return SimpleNamespace(text=text, function_calls=calls or [])


def _gfc(name, args=None, **extra):
    return SimpleNamespace(name=name, args=args or {}, **extra)


class _FakeGeminiStreaming:
    """models.generate_content_stream(...) → a fresh iterator per turn: first a
    tool-call turn, then a text turn."""
    def __init__(self):
        self._turns = [
            [_gchunk(calls=[_gfc("get_business_snapshot")])],
            [_gchunk(text="Here "), _gchunk(text="you go.")],
        ]
        self.models = SimpleNamespace(generate_content_stream=self._stream)

    def _stream(self, **kw):
        return iter(self._turns.pop(0))


def test_stream_tool_loop_gemini_events_and_execution(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    calls = []
    with patch.object(llm, "_gemini", return_value=_FakeGeminiStreaming()):
        evs = _events(llm.stream_tool_loop(
            system="s", messages=[{"role": "user", "content": "how's business?"}],
            tools=_TOOLS, execute=lambda n, a: calls.append(n) or {"clients": 3}))
    kinds = [e["type"] for e in evs]
    assert "tool_call" in kinds and kinds[-1] == "final"
    assert {"type": "tool_result", "name": "get_business_snapshot", "preview": '{"clients": 3}'} in evs
    assert evs[-1]["text"] == "Here you go."
    assert evs[-1]["tools_used"] == ["get_business_snapshot"]
    assert calls == ["get_business_snapshot"]


def test_stream_tool_loop_gemini_runs_a_repeated_call_once(monkeypatch):
    # A function call can echo across chunks; the loop must act on it once.
    monkeypatch.setenv("LLM_PROVIDER", "gemini")

    class _Echoing:
        def __init__(self):
            self._turns = [
                [_gchunk(calls=[_gfc("get_business_snapshot")]),
                 _gchunk(calls=[_gfc("get_business_snapshot")])],
                [_gchunk(text="done.")],
            ]
            self.models = SimpleNamespace(generate_content_stream=lambda **kw: iter(self._turns.pop(0)))

    calls = []
    with patch.object(llm, "_gemini", return_value=_Echoing()):
        evs = _events(llm.stream_tool_loop(
            system="s", messages=[{"role": "user", "content": "x"}], tools=_TOOLS,
            execute=lambda n, a: calls.append(n) or {"ok": 1}))
    assert calls == ["get_business_snapshot"]  # executed once, not twice
    assert evs[-1]["text"] == "done."
