"""The AI router's provider seam.

`services/llm.py` is unit-tested on its own; this file proves the *router* wires
into it correctly: with LLM_PROVIDER=gemini the `_anthropic_client()` the call
sites use becomes a Gemini-backed shim that still answers
`client.messages.create(...)` in the Anthropic response shape, and
`_run_tool_loop` runs the bounded loop through the Gemini adapter while keeping
org-scoping and the read-only operations gate. The default (anthropic) path is
left exactly as it was — asserted by the whole existing AI suite, which runs
with the flag unset.
"""
from types import SimpleNamespace

import pytest

from modules.ai import router as ai_router
from services import llm


# --- the shim the non-tool call sites use ------------------------------------

def test_client_is_a_gemini_shim_when_flag_is_gemini(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    client = ai_router._anthropic_client()
    assert isinstance(client, ai_router._GeminiChatShim)


def test_client_is_none_without_the_providers_key(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert ai_router._anthropic_client() is None


def test_shim_create_returns_anthropic_shaped_text(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    # Stand in for the real Gemini SDK client at the llm boundary.
    fake = SimpleNamespace(models=SimpleNamespace(
        generate_content=lambda **kw: SimpleNamespace(text="Drafted on Gemini.")))
    monkeypatch.setattr(llm, "_gemini", lambda: fake)

    resp = ai_router._anthropic_client().messages.create(
        model=ai_router._TIER_MODEL_IDS["haiku"], max_tokens=200, system="s",
        messages=[{"role": "user", "content": "draft it"}])
    # Call sites do: "".join(b.text for b in resp.content if b.type == "text")
    assert [b.text for b in resp.content if b.type == "text"] == ["Drafted on Gemini."]
    assert resp.stop_reason == "end_turn"


def test_shim_flattens_a_multiturn_history_into_one_prompt():
    # Crew /ask sends a short history; complete_text takes one user string, so
    # the shim labels and joins the turns. A lone user message passes through
    # as just its text (what every other call site sends).
    flat = ai_router._GeminiChatShim._flatten(
        [{"role": "user", "content": "hi"},
         {"role": "assistant", "content": "hello"},
         {"role": "user", "content": "when do I start?"}])
    assert flat == "User: hi\n\nAssistant: hello\n\nUser: when do I start?"
    assert ai_router._GeminiChatShim._flatten(
        [{"role": "user", "content": "just me"}]) == "just me"


def test_tier_for_model_maps_back_to_the_tier(monkeypatch):
    assert ai_router._tier_for_model(ai_router._TIER_MODEL_IDS["haiku"]) == "haiku"
    assert ai_router._tier_for_model(ai_router._TIER_MODEL_IDS["opus"]) == "opus"
    assert ai_router._tier_for_model("something-unknown") == "sonnet"


# --- the tool loop routes through the Gemini adapter under the flag ----------

def test_run_tool_loop_delegates_to_gemini_and_keeps_scoping(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "k")

    seen = {}

    def fake_loop(*, system, user_content, tools, execute, tier, max_tokens, max_iters):
        # Prove the execute closure still carries org-scoping and the gate.
        execute("get_business_snapshot", {})
        return "answer via gemini"

    monkeypatch.setattr(llm, "run_tool_loop", fake_loop)

    def fake_execute(name, args, agent, *, org_id, allow_operations):
        seen.update(name=name, org_id=org_id, allow_operations=allow_operations)
        return {"ok": True}

    monkeypatch.setattr(ai_router, "execute_tool", fake_execute)

    out = ai_router._run_tool_loop(
        client=ai_router._anthropic_client(), system="s", user_content="how's business?",
        org_id=42, allow_operations=False)
    assert out == "answer via gemini"
    assert seen == {"name": "get_business_snapshot", "org_id": 42, "allow_operations": False}


def test_run_tool_loop_stays_on_anthropic_by_default(monkeypatch):
    # Flag unset → the original in-router loop runs against the passed client,
    # not the llm seam. A fake Anthropic client with a tool-use turn then a
    # final text turn drives it, and llm.run_tool_loop must NOT be called.
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.setattr(llm, "run_tool_loop",
                        lambda **kw: pytest.fail("must not route through the seam on anthropic"))
    monkeypatch.setattr(ai_router, "execute_tool",
                        lambda *a, **k: {"clients": 3})

    turns = [
        SimpleNamespace(stop_reason="tool_use", content=[
            SimpleNamespace(type="tool_use", name="get_business_snapshot", input={}, id="t1")]),
        SimpleNamespace(stop_reason="end_turn", content=[
            SimpleNamespace(type="text", text="All good.")]),
    ]
    fake = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: turns.pop(0)))

    out = ai_router._run_tool_loop(client=fake, system="s", user_content="hi", org_id=1)
    assert out == "All good."
