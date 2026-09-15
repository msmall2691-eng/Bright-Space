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
# Defaults are gemini-3.6-flash across the board: Google retired the gemini-2.5-*
# ids for new API keys (a 404 that names 3.6-flash as the replacement), and it's
# the one current model we can rely on being available. Point the fast tier at a
# -flash-lite and the hard tier at a larger model via these env vars once you've
# confirmed those ids for your key (GET .../v1beta/models) — that's the tiering,
# and it's one env var, not a deploy.
_GEMINI_TIERS = {
    "haiku": os.getenv("GEMINI_MODEL_FAST", "gemini-3.6-flash"),
    "sonnet": os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
    "opus": os.getenv("GEMINI_MODEL_PRO", "gemini-3.6-flash"),
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


def stream_tool_loop(*, system: str, messages: list[dict], tools: list[dict],
                     execute: Callable[[str, dict], Any], tier: str = "sonnet",
                     max_tokens: int = 4096, max_iters: int = 8):
    """Streaming sibling of ``run_tool_loop`` for the live Workspace chat.

    ``messages`` is the running conversation as plain ``{role, content}`` dicts
    (role ``user``/``assistant``, content a string) — the same history the
    websocket already keeps. This is a generator: it yields event dicts the
    transport layer renders, in order, and always ends with exactly one
    ``final`` event:

        {"type": "chunk",       "text": str}          # a token delta
        {"type": "tool_call",   "name": str}          # the model is calling a tool
        {"type": "tool_result", "name": str, "preview": str}
        {"type": "final",       "text": str, "tools_used": list[str]}

    ``execute(name, args) -> dict`` runs one tool; the caller keeps org-scoping
    and the read-only operations gate inside it, exactly as the non-streaming
    loop does. Tool previews are truncated to 120 chars to match the existing
    wire shape."""
    model = model_for_tier(tier)
    if provider() == "gemini":
        yield from _gemini_stream_tool_loop(system, messages, tools, execute, model, max_tokens, max_iters)
    else:
        yield from _anthropic_stream_tool_loop(system, messages, tools, execute, model, max_tokens, max_iters)


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


def _anthropic_stream_tool_loop(system, messages, tools, execute, model, max_tokens, max_iters):
    client = _anthropic()
    loop_messages = list(messages)
    tools_used: list[str] = []
    final_text = ""
    for _ in range(max_iters):
        turn_text = ""
        with client.messages.stream(model=model, max_tokens=max_tokens, system=system,
                                    messages=loop_messages, tools=tools) as stream:
            for event in stream:
                if event.type == "content_block_delta" and hasattr(event.delta, "text"):
                    turn_text += event.delta.text
                    yield {"type": "chunk", "text": event.delta.text}
                elif event.type == "content_block_start" and event.content_block.type == "tool_use":
                    yield {"type": "tool_call", "name": event.content_block.name}
            final_msg = stream.get_final_message()
        if final_msg.stop_reason != "tool_use":
            final_text = turn_text
            break
        tool_results = []
        for block in final_msg.content:
            if block.type == "tool_use":
                out = execute(block.name, dict(block.input))
                result_text = json.dumps(out, default=str)
                tools_used.append(block.name)
                yield {"type": "tool_result", "name": block.name, "preview": result_text[:120]}
                tool_results.append({"type": "tool_result", "tool_use_id": block.id,
                                     "content": result_text})
        loop_messages.append({"role": "assistant", "content": final_msg.content})
        loop_messages.append({"role": "user", "content": tool_results})
    yield {"type": "final", "text": final_text, "tools_used": tools_used}


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
    # Hold the Client in a local for the whole call. As a throwaway
    # (`_gemini().models.generate_content(...)`) the Client can be GC'd and its
    # httpx transport closed mid-call, and the SDK's internal retry then dies
    # with "Cannot send a request, as the client has been closed" instead of
    # surfacing the real error — every other adapter here already binds it.
    client = _gemini()
    cfg = _gemini_config(system, max_tokens, json_mode=json_mode, temperature=temperature)
    resp = client.models.generate_content(model=model, contents=user_content, config=cfg)
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


def _gemini_fn_response(out):
    """A tool result, as a JSON-safe dict for a Gemini functionResponse part.

    The genai SDK ``json.dumps()`` the request body with no ``default=``, so a
    raw ``date`` / ``Decimal`` / model object in a tool result crashes
    serialization ("Object of type date is not JSON serializable") — the
    Anthropic path already sidesteps this with ``json.dumps(..., default=str)``.
    Coerce the whole payload to plain JSON types the same way, and wrap a
    non-dict result (from_function_response needs a dict)."""
    payload = out if isinstance(out, dict) else {"result": out}
    return json.loads(json.dumps(payload, default=str))


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
                name=c.name, response=_gemini_fn_response(out)))
        contents.append(types.Content(role="user", parts=parts))
    return (resp.text or "").strip() if resp else ""


def _gemini_contents_from_messages(messages):
    """Plain {role, content:str} history → Gemini Content list. Assistant turns
    map to role 'model'; anything without a string body is skipped."""
    from google.genai import types
    out = []
    for m in messages:
        content = m.get("content")
        if not isinstance(content, str):
            continue
        role = "model" if m.get("role") == "assistant" else "user"
        out.append(types.Content(role=role, parts=[types.Part.from_text(text=content)]))
    return out


def _gemini_stream_tool_loop(system, messages, tools, execute, model, max_tokens, max_iters):
    from google.genai import types
    client = _gemini()
    cfg = _gemini_config(system, max_tokens, tools=_gemini_tools(tools))
    contents = _gemini_contents_from_messages(messages)
    tools_used: list[str] = []
    final_text = ""
    for _ in range(max_iters):
        turn_text = ""
        calls = []
        seen = set()  # a function call can echo across chunks; act on each once
        for chunk in client.models.generate_content_stream(
                model=model, contents=contents, config=cfg):
            piece = chunk.text or ""
            if piece:
                turn_text += piece
                yield {"type": "chunk", "text": piece}
            for fc in (chunk.function_calls or []):
                if getattr(fc, "will_continue", None) or getattr(fc, "partial_args", None):
                    continue  # a partial (still-streaming) call — wait for the whole thing
                sig = (fc.name, json.dumps(fc.args or {}, sort_keys=True, default=str))
                if sig in seen:
                    continue
                seen.add(sig)
                calls.append(fc)
        if not calls:
            final_text = turn_text
            break
        # Record the model's turn (any text it spoke, then its calls), then answer
        # each call with a user-role functionResponse part (Gemini's convention).
        model_parts = ([types.Part.from_text(text=turn_text)] if turn_text else []) \
            + [types.Part(function_call=fc) for fc in calls]
        contents.append(types.Content(role="model", parts=model_parts))
        resp_parts = []
        for fc in calls:
            yield {"type": "tool_call", "name": fc.name}
            out = execute(fc.name, dict(fc.args or {}))
            tools_used.append(fc.name)
            yield {"type": "tool_result", "name": fc.name,
                   "preview": json.dumps(out, default=str)[:120]}
            resp_parts.append(types.Part.from_function_response(
                name=fc.name, response=_gemini_fn_response(out)))
        contents.append(types.Content(role="user", parts=resp_parts))
    yield {"type": "final", "text": final_text, "tools_used": tools_used}
