"""Map raw LLM/Anthropic exceptions to friendly, user-safe messages.

The AI surfaces (Ask AI, the Workspace agents) used to print str(exc) straight to
the end user — which leaks the provider's raw 400 JSON, request_id, and billing
wording (e.g. "Your credit balance is too low to access the Anthropic API").
friendly_ai_error() turns those into a calm, actionable sentence and never
exposes internals. Detection is by exception class name + message substring so we
don't have to import the anthropic SDK here.
"""


def friendly_ai_error(exc) -> str:
    name = type(exc).__name__
    msg = str(exc).lower()

    # Billing / quota — the most common real-world failure.
    if "credit balance" in msg or "billing" in msg or "insufficient" in msg or "quota" in msg:
        return ("The AI assistant is temporarily unavailable while its plan is "
                "topped up. Please let your administrator know — everything else "
                "in BrightBase keeps working.")
    # Auth / missing-or-bad key.
    if name == "AuthenticationError" or "authentication" in msg or "api key" in msg or "x-api-key" in msg:
        return ("The AI assistant isn't configured correctly (API key). Please "
                "contact your administrator.")
    # Rate limit / model overloaded.
    if name in ("RateLimitError", "OverloadedError") or "rate limit" in msg or "overloaded" in msg or "429" in msg:
        return "The AI assistant is busy right now — please try again in a moment."
    # Network / timeout reaching the provider.
    if name in ("APIConnectionError", "APITimeoutError") or "timeout" in msg or "connection" in msg:
        return "Couldn't reach the AI service. Please check the connection and try again."

    return "Sorry, the AI assistant ran into a problem. Please try again in a moment."
