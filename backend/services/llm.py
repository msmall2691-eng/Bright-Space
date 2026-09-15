"""Provider-agnostic LLM access for BrightBase's AI features.

BrightBase's AI was wired directly to Anthropic (the SDK, the model IDs, and the
tool-use / response parsing) in ~8 places. This module is the seam that lets the
same features run on Google Gemini instead, chosen by one env var:

    LLM_PROVIDER = "anthropic" (default) | "gemini"

Nothing changes until that flag is flipped, and each provider is used only when
its key is present (``available()``), so a mis-set flag degrades to the same
"assistant unavailable" fallbacks the callers already have — never a crash.

Two entry points cover every non-streaming AI call in the app:

* ``complete_text(...)``  — one-shot: system + user text in, text (or JSON) out.
* ``run_tool_loop(...)``  — the bounded agentic loop: the model may call the
  read-only business tools until it produces a final text answer. Tools are
  declared ONCE in Anthropic's ``{name, description, input_schema}`` shape (the
  format ``agents/tools.py`` already uses) and each adapter converts them to its
  own dialect — Gemini takes the JSON schema verbatim via
  ``parameters_json_schema``, so there is nothing to hand-translate.

The streaming Workspace agent chat (main.py's websocket) is a separate, harder
port and is intentionally NOT covered here yet — see the PR.
"""
import json
import logging
import os
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

_TIERS = ("haiku", "sonnet", "opus")


def provider() -> str:
    """The configured LLM provider, lowercased. Defaults to anthropic so an
    unset env changes nothing."""
    return (os.getenv("LLM_PROVIDER") or "anthropic").strip().lower()


# Tier → model id, per provider, every one env-overridable. The tier names are
# BrightBase's own ("haiku"=cheap/routing, "sonnet"=standard, "opus"=hardest);
# they map onto each provider's small/standard/large model. Gemini model IDs
# move fast — they're all overridable so a name change is one env var, not a
# deploy.
_ANTHROPIC_TIERS = {
    "haiku": os.getenv("AGENT_MODEL_HAIKU", "claude-haiku-4-5-20251001"),
    "sonnet": os.getenv("AGENT_MODEL_SONNET", "claude-sonnet-4-6"),
    "opus": os.getenv("AGENT_MODEL_OPUS", "claude-opus-4-8"),
}
_GEMINI_TIERS = {
    "haiku": os.getenv("GEMINI_MODEL_FAST", "gemini-2.5-flash-lite"),
    "sonnet": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    "opus": os.getenv("GEMINI_MODEL_PRO", "gemini-2.5-pro"),
}


def model_for_tier(tier: str) -> str:
    tier = tier if tier in _TIERS else "sonnet"
    table = _GEMINI_TIERS if provider() == "gemini" else _ANTHROPIC_TIERS
    return table[tier]


def available() -> bool:
    """Is the configured provider usable (its API key is set)? Callers keep
    their existing ``if not available: <deterministic fallback>`` guard."""
    if provider() == "gemini":
        return bool(os.getenv("GEMINI_API_KEY"))
    return bool(os.getenv("ANTHROPIC_API_KEY"))


# --- one-shot completion -----------------------------------------------------

def complete_text(*, system: str, user_content: str, tier: str = "sonnet",
                  max_tokens: int = 1024, json_mode: bool = False,
                  temperature: Optional[float] = None) -> str:
    """System + user text in, model's text out. ``json_mode`` asks the provider
    for JSON where it can (Gemini's response_mime_type); callers still run their
    own tolerant JSON extraction, so it's a hint, not a contract."""
    model = model_for_tier(tier)
    if provider() == "gemini":
        return _gemini_complete(system, user_content, model, max_tokens, json_mode, temperature)
    return _anthropic_complete(system, user_content, model, max_tokens, temperature)


def run_tool_loop(*, system: str, user_content: str, tools: list[dict],
                  execute: Callable[[str, dict], Any], tier: str = "sonnet",
                  max_tokens: int = 1024, max_iters: int = 5) -> str:
    """Bounded agentic loop. ``tools`` is the Anthropic-shaped list
    (``{name, description, input_schema}``); ``execute(name, args) -> dict`` runs
    one tool and returns its result (the caller keeps org-scoping / gating). The
    model may call tools until it yields a final text answer, or ``max_iters`` is
    hit; returns the final text."""
    model = model_for_tier(tier)
    if provider() == "gemini":
        return _gemini_tool_loop(system, user_content, tools, execute, model, max_tokens, max_iters)
    return _anthropic_tool_loop(system, user_content, tools, execute, model, max_tokens, max_iters)


# --- Anthropic adapter -------------------------------------------------------

def _anthropic():
    import anthropic
    return anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


def _anthropic_complete(system, user_content, model, max_tokens, temperature):
    kwargs = dict(model=model, max_tokens=max_tokens, system=system,
                  messages=[{"role": "user", "content": user_content}])
    if temperature is not None:
        kwargs["temperature"] = temperature
    resp = _anthropic().messages.create(**kwargs)
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def _anthropic_tool_loop(system, user_content, tools, execute, model, max_tokens, max_iters):
    client = _anthropic()
    messages = [{"role": "user", "content": user_content}]
    resp = None
    for _ in range(max_iters):
        resp = client.messages.create(model=model, max_tokens=max_tokens,
                                       system=system, messages=messages, tools=tools)
        if resp.stop_reason != "tool_use":
            return "".join(b.text for b in resp.content if b.type == "text").strip()
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for block in resp.content:
            if block.type == "tool_use":
                out = execute(block.name, dict(block.input))
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": json.dumps(out, default=str)})
        messages.append({"role": "user", "content": results})
    return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip() if resp else ""


# --- Gemini adapter ----------------------------------------------------------

def _gemini():
    from google import genai
    return genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


def _gemini_config(system, max_tokens, *, json_mode=False, temperature=None, tools=None):
    from google.genai import types
    return types.GenerateContentConfig(
        system_instruction=system or None,
        max_output_tokens=max_tokens,
        temperature=temperature,
        response_mime_type="application/json" if json_mode else None,
        tools=tools,
        # We run the tool loop ourselves (org-scoping / gating live in execute),
        # so disable the SDK's own auto-calling.
        automatic_function_calling=(
            types.AutomaticFunctionCallingConfig(disable=True) if tools else None
        ),
    )


def _gemini_complete(system, user_content, model, max_tokens, json_mode, temperature):
    cfg = _gemini_config(system, max_tokens, json_mode=json_mode, temperature=temperature)
    resp = _gemini().models.generate_content(model=model, contents=user_content, config=cfg)
    return (resp.text or "").strip()


def _gemini_tools(tools):
    """Anthropic tool dicts → a Gemini Tool. The JSON input_schema is passed
    through verbatim (parameters_json_schema), so nothing is hand-translated."""
    from google.genai import types
    decls = [
        types.FunctionDeclaration(
            name=t["name"],
            description=t.get("description", ""),
            parameters_json_schema=t.get("input_schema") or {"type": "object", "properties": {}},
        )
        for t in tools
    ]
    return [types.Tool(function_declarations=decls)] if decls else None


def _gemini_tool_loop(system, user_content, tools, execute, model, max_tokens, max_iters):
    from google.genai import types
    client = _gemini()
    cfg = _gemini_config(system, max_tokens, tools=_gemini_tools(tools))
    contents = [types.Content(role="user", parts=[types.Part.from_text(text=user_content)])]
    resp = None
    for _ in range(max_iters):
        resp = client.models.generate_content(model=model, contents=contents, config=cfg)
        calls = resp.function_calls or []
        if not calls:
            return (resp.text or "").strip()
        # Record the model's function-call turn, then answer each call. A tool
        # result goes back as a user-role functionResponse part (Gemini's
        # convention), and from_function_response needs a dict, so non-dict
        # results are wrapped.
        contents.append(resp.candidates[0].content)
        parts = []
        for c in calls:
            out = execute(c.name, dict(c.args or {}))
            parts.append(types.Part.from_function_response(
                name=c.name, response=out if isinstance(out, dict) else {"result": out}))
        contents.append(types.Content(role="user", parts=parts))
    return (resp.text or "").strip() if resp else ""
