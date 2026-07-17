# Force redeploy - fixing quoting router import syntax error in production
import json
import os
import secrets
import yaml
from pathlib import Path

from dotenv import load_dotenv
# Must run before any local import below — auth_jwt (JWT_SECRET) and
# database.db (DATABASE_URL) both read their required env vars at MODULE
# IMPORT time and fail closed if unset. Previously load_dotenv() ran at
# line ~50, after ~25 local imports including both of those — so a
# JWT_SECRET or DATABASE_URL supplied only via backend/.env (not the
# parent shell's real environment) would never be loaded in time, and the
# app would refuse to start even though the secret WAS configured (codex
# P2 on PR #542, surfaced by the new JWT_SECRET fail-closed check).
load_dotenv()

import anthropic
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agents.tools import get_tools_for_agent, execute_tool, load_agent_roster
from modules.ai.router import review_agent_turn

from auth import APIKeyMiddleware
from auth_jwt import verify_jwt
from ratelimit import limiter
from database.db import init_db
from scheduler import start_scheduler, stop_scheduler, sync_all_ical_feeds_tick
from modules.clients.router import router as clients_router
from modules.quoting.router import router as quoting_router
from modules.scheduling.router import router as scheduling_router
from modules.invoicing.router import router as invoicing_router
from modules.dispatch.router import router as dispatch_router
from modules.payroll.router import router as payroll_router
from modules.connecteam.router import router as connecteam_router
from modules.comms.router import router as comms_router
from modules.properties.router import router as properties_router
from modules.recurring.router import router as recurring_router
from modules.reminders.router import router as reminders_router
from modules.intake.router import router as intake_router
from modules.booking.router import router as booking_router
from modules.fields.router import router as fields_router
from modules.opportunities.router import router as opportunities_router
from modules.activities.router import router as activities_router
from modules.integration_events.router import router as integration_events_router
from modules.search import router as search_router
from modules.geo.router import router as geo_router
from modules.settings.router import router as settings_router
from modules.views.router import router as views_router
from modules.auth.router import router as auth_router, require_role
from modules.admin.router import router as admin_router
from modules.ai.router import router as ai_router
from modules.dashboard.router import router as dashboard_router
from modules.scheduling.router import schedule_router
from modules.portal.router import router as portal_router

app = FastAPI(title="BrightBase API", version="1.0.0")

# BB-OPS-01: wire rate limiter so @limiter.limit() decorators fire.
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

from config import resolve_cors_origins
# Force-merge the required production origins so a partial ALLOWED_ORIGINS env
# override can't silently drop maineclean.co and lose inbound website leads.
_allowed_origins = resolve_cors_origins(os.getenv("ALLOWED_ORIGINS"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    # BB-CODE-02: was ["*"] / ["*", "X-API-Key"] which paired with
    # allow_credentials=True is permissive enough to bite the moment a new
    # origin is added. Explicit lists match what the SPA actually sends.
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
    # Sliding-session: let the SPA read the rotated token off the response.
    expose_headers=["X-Refresh-Token"],
)

# Compress JSON/text responses over the wire. The API returns large list
# payloads (conversations, jobs, opportunities, properties) that gzip to a
# fraction of their size; minimum_size skips tiny bodies where compression
# overhead isn't worth it. Honors the client's Accept-Encoding automatically.
app.add_middleware(GZipMiddleware, minimum_size=1000)

# API key authentication â must be added AFTER CORS middleware
# (Starlette processes middleware in reverse order, so CORS runs first)
app.add_middleware(APIKeyMiddleware)

# Sliding-session refresh: when an authenticated request carries a token past
# its half-life, hand back a fresh one via X-Refresh-Token so active users (e.g.
# mid-booking) are never logged out underneath their work.
from auth_jwt import maybe_refresh_jwt


@app.middleware("http")
async def sliding_session_refresh(request, call_next):
    response = await call_next(request)
    try:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            fresh = maybe_refresh_jwt(auth[7:])
            if fresh:
                response.headers["X-Refresh-Token"] = fresh
    except Exception:
        pass  # never let session-refresh bookkeeping break a response
    return response


# Phase 0 instrumentation: log "METHOD path status duration_ms" for every
# request so the slowest endpoints surface in the Railway logs within an hour of
# real use — no guessing about where the lag is. Slow requests (>1s) log at
# WARNING so they stand out; the duration is also echoed in X-Process-Time-Ms
# for quick inspection in the browser network tab. Defined last so it's the
# outermost middleware and times the whole request, including the inner layers.
import time as _time
import logging as _logging

_perf_logger = _logging.getLogger("brightbase.perf")
if not _perf_logger.handlers:
    _h = _logging.StreamHandler()
    _h.setFormatter(_logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    _perf_logger.addHandler(_h)
    _perf_logger.setLevel(_logging.INFO)


@app.middleware("http")
async def request_timing(request, call_next):
    start = _time.perf_counter()
    response = await call_next(request)
    duration_ms = (_time.perf_counter() - start) * 1000
    try:
        response.headers["X-Process-Time-Ms"] = f"{duration_ms:.0f}"
        level = _logging.WARNING if duration_ms > 1000 else _logging.INFO
        _perf_logger.log(
            level, "%s %s %s %.0fms",
            request.method, request.url.path, response.status_code, duration_ms,
        )
    except Exception:
        pass  # instrumentation must never break a response
    return response


app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(clients_router, prefix="/api/clients", tags=["clients"])
app.include_router(quoting_router, prefix="/api/quotes", tags=["quotes"])
app.include_router(scheduling_router, prefix="/api/jobs", tags=["scheduling"])
app.include_router(invoicing_router, prefix="/api/invoices", tags=["invoicing"])
app.include_router(dispatch_router, prefix="/api/dispatch", tags=["dispatch"])
app.include_router(payroll_router, prefix="/api/payroll", tags=["payroll"])
app.include_router(connecteam_router, prefix="/api/connecteam", tags=["connecteam"])
app.include_router(comms_router, prefix="/api/comms", tags=["comms"])
app.include_router(properties_router, prefix="/api/properties", tags=["properties"])
app.include_router(recurring_router, prefix="/api/recurring", tags=["recurring"])
app.include_router(reminders_router, prefix="/api/reminders", tags=["reminders"])
app.include_router(intake_router, prefix="/api/intake", tags=["intake"])
app.include_router(booking_router, prefix="/api/booking", tags=["booking"])
from modules.integrations.router import router as integrations_router
app.include_router(integrations_router, prefix="/api/integrations", tags=["integrations"])
app.include_router(fields_router, prefix="/api/fields", tags=["fields"])
app.include_router(opportunities_router, prefix="/api/opportunities", tags=["opportunities"])
app.include_router(activities_router, prefix="/api/activities", tags=["activities"])
app.include_router(integration_events_router, prefix="/api/integration-events", tags=["integration-events"])
app.include_router(search_router, prefix="/api/search", tags=["search"])
app.include_router(geo_router, prefix="/api/geo", tags=["geo"])
app.include_router(settings_router, prefix="/api/settings", tags=["settings"])
app.include_router(views_router, prefix="/api/views", tags=["views"])
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])
app.include_router(ai_router, prefix="/api/ai", tags=["ai"])
app.include_router(dashboard_router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(schedule_router, prefix="/api/schedule", tags=["schedule"])
app.include_router(portal_router, prefix="/api/portal", tags=["portal"])

# Per-connection conversation histories: {connection_key: [messages]}
# BB-CODE-03: bounded so a long chat doesn't accumulate megabytes per session
# (Anthropic's context window is the real ceiling, but we don't need to
# carry the entire transcript every turn). Older messages are dropped from
# the front of the list when the cap is exceeded; system prompt is sent
# fresh every turn via config["system_prompt"] so trimming user/assistant
# pairs is safe.
AGENT_HISTORY_MAX_MESSAGES = int(os.getenv("AGENT_HISTORY_MAX_MESSAGES", "40"))
agent_histories: dict[str, list] = {}

# Model tiers the chat UI can request per turn (cost vs. accuracy). "sonnet"
# is the long-standing default (matches modules/ai/router.py's MODEL) so
# behavior is unchanged unless a caller explicitly asks for a cheaper/pricier
# tier. Overridable via env in case Anthropic retires/renames one of these
# ids before this comment is updated.
MODEL_TIERS = {
    "haiku": os.getenv("AGENT_MODEL_HAIKU", "claude-haiku-4-5-20251001"),
    "sonnet": os.getenv("AGENT_MODEL_SONNET", "claude-sonnet-4-6"),
    "opus": os.getenv("AGENT_MODEL_OPUS", "claude-opus-4-8"),
}
DEFAULT_AGENT_MODEL_TIER = "sonnet"


def _trim_history(conn_key: str) -> None:
    h = agent_histories.get(conn_key)
    if not h or len(h) <= AGENT_HISTORY_MAX_MESSAGES:
        return
    # Keep the tail. If the trim point lands mid-tool-use (assistant message
    # whose next entry was a tool_result), shave one more so we don't leave
    # an orphaned tool_use without its result.
    overflow = len(h) - AGENT_HISTORY_MAX_MESSAGES
    agent_histories[conn_key] = h[overflow:]


def load_agent_config(agent_name: str) -> dict:
    config_path = Path(__file__).parent / "agents" / f"{agent_name}.yaml"
    if not config_path.exists():
        raise ValueError(f"Agent '{agent_name}' not found")
    with open(config_path) as f:
        return yaml.safe_load(f)


@app.on_event("startup")
async def startup():
    init_db()
    start_scheduler()

    # Loudly flag a behind-on-migrations DB (the usual cause of mysterious 500s)
    # so it screams in the logs at boot instead of failing per-endpoint.
    from database.db import check_schema_drift
    drift = check_schema_drift()
    if drift.get("ok") is False:
        print(f"🛑 SCHEMA DRIFT: DB at migration {drift.get('db_revision')} but code head is "
              f"{drift.get('head_revision')}. Run 'alembic upgrade head' — endpoints reading newer "
              f"columns may 500 until then.")
    elif drift.get("ok"):
        print(f"✓ DB schema at head ({drift.get('head_revision')})")
    else:
        print(f"⚠️  Schema-drift check skipped: {drift.get('error')}")

    # The startup visits-coverage check was removed by the Job/Visit
    # unification (docs/job-visit-unification.md). Occurrences are Jobs now;
    # there is nothing to drift.

    print("BrightBase backend started")


@app.on_event("shutdown")
async def shutdown():
    stop_scheduler()
    print("BrightBase backend shutdown")


@app.post("/api/admin/ical-sync-now", dependencies=[Depends(require_role("admin", "manager"))])
async def manual_ical_sync():
    """Manually trigger iCal sync for all properties."""
    return sync_all_ical_feeds_tick()


@app.get("/api/version")
async def version():
    """Report which build is actually running so 'did my deploy take?' has a
    one-request answer. Railway injects RAILWAY_GIT_COMMIT_SHA and friends into
    every container it deploys — reading them at request time (not import time)
    means we always see the running container's values, and the endpoint stays
    working when Railway isn't the host (returns empty strings)."""
    return {
        "commit": os.getenv("RAILWAY_GIT_COMMIT_SHA", "")[:12] or "unknown",
        "branch": os.getenv("RAILWAY_GIT_BRANCH", "") or "unknown",
        "commit_message": os.getenv("RAILWAY_GIT_COMMIT_MESSAGE", "").splitlines()[0][:200],
        "deployment_id": os.getenv("RAILWAY_DEPLOYMENT_ID", ""),
        "service": "BrightBase",
    }


@app.get("/api/health")
async def health():
    # Surface schema-drift state here (not just in startup logs) so a
    # behind-on-migrations DB — the usual cause of "column does not exist"
    # 500s like the GET/POST /api/quotes failures — can be diagnosed from the
    # browser without log access. Fail-soft: check_schema_drift() never raises.
    from database.db import check_schema_drift
    drift = check_schema_drift()
    return {
        "status": "ok",
        "service": "BrightBase",
        "schema": {
            "ok": drift.get("ok"),
            "db_revision": drift.get("db_revision"),
            "head_revision": drift.get("head_revision"),
            "error": drift.get("error"),
        },
    }


@app.get("/api/agents")
async def list_agents():
    return load_agent_roster()


@app.websocket("/ws/agent/{agent_name}")
async def agent_websocket(websocket: WebSocket, agent_name: str):
    # BaseHTTPMiddleware does not see WebSocket connections, so the
    # APIKeyMiddleware can't gate this route — auth has to happen here.
    # Browsers can't set headers on WS connects, so JWT and API key both
    # come in via query params (?token=... or ?api_key=...).
    #
    # Fail CLOSED, mirroring auth.py's APIKeyMiddleware: a valid JWT always
    # authenticates regardless of whether BRIGHTBASE_API_KEY is configured.
    # Previously the whole check lived inside `if expected_key:`, so an
    # unset key skipped authentication entirely — including the JWT check —
    # and every connection was accepted unauthenticated. No valid JWT and no
    # key configured now means there's no way to authenticate the
    # connection, so it's rejected rather than let through.
    token = websocket.query_params.get("token", "")
    authed = bool(token and verify_jwt(token))
    if not authed:
        expected_key = os.getenv("BRIGHTBASE_API_KEY", "")
        if not expected_key:
            _logging.getLogger(__name__).error(
                "[auth] BRIGHTBASE_API_KEY not set and no valid JWT — rejecting WS connection."
            )
        else:
            provided_key = websocket.query_params.get("api_key", "")
            authed = bool(provided_key) and secrets.compare_digest(provided_key, expected_key)
    if not authed:
        await websocket.close(code=1008, reason="unauthorized")
        return

    await websocket.accept()
    conn_key = f"{id(websocket)}_{agent_name}"

    try:
        config = load_agent_config(agent_name)
    except ValueError as e:
        await websocket.send_json({"type": "error", "content": str(e)})
        await websocket.close()
        return

    if conn_key not in agent_histories:
        agent_histories[conn_key] = []

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        await websocket.send_json({"type": "error", "content": "ANTHROPIC_API_KEY not configured"})
        await websocket.close()
        return

    client = anthropic.Anthropic(api_key=api_key)

    tools = get_tools_for_agent(agent_name)

    try:
        while True:
            data = await websocket.receive_json()
            message = data.get("message", "").strip()
            if not message:
                continue

            if data.get("clear"):
                agent_histories[conn_key] = []
                await websocket.send_json({"type": "cleared"})
                continue

            # Model tier: the chat UI's router picks this per-TURN (cheap
            # "haiku" for simple questions, "sonnet" for anything needing
            # real reasoning/tool use), so it's read from each incoming
            # message rather than fixed once at connect time. This used to
            # be a `?model=` query param on the socket URL, with sockets
            # keyed client-side by `${agentId}:${model}` — so a follow-up
            # the router classified into a cheaper tier than the original
            # turn (a plain "yes" after a "sonnet" turn, say) opened a
            # DIFFERENT socket, and since conn_key below is tied to the
            # websocket connection's own identity, that follow-up landed in
            # a brand-new, empty history — silently losing the very
            # conversation the continuity fix was meant to preserve. One
            # persistent connection per agent, with model chosen per
            # message, keeps history keyed purely on "which agent," not
            # "which agent at which price point."
            requested_tier = data.get("model", DEFAULT_AGENT_MODEL_TIER)
            model_id = MODEL_TIERS.get(requested_tier, MODEL_TIERS[DEFAULT_AGENT_MODEL_TIER])

            agent_histories[conn_key].append({"role": "user", "content": message})
            _trim_history(conn_key)

            # Agentic tool-use loop
            loop_messages = list(agent_histories[conn_key])
            final_text = ""
            tools_used = []  # every tool name called this turn, for the QC pass below

            while True:
                full_text = ""
                tool_uses = []

                with client.messages.stream(
                    model=model_id,
                    max_tokens=4096,
                    system=config["system_prompt"],
                    messages=loop_messages,
                    tools=tools,
                ) as stream:
                    for event in stream:
                        # Stream text chunks to frontend
                        if event.type == "content_block_delta" and hasattr(event.delta, "text"):
                            full_text += event.delta.text
                            await websocket.send_json({"type": "chunk", "content": event.delta.text})
                        # Notify frontend when a tool call starts
                        elif event.type == "content_block_start":
                            cb = event.content_block
                            if cb.type == "tool_use":
                                await websocket.send_json({"type": "tool_call", "name": cb.name})

                    final_msg = stream.get_final_message()

                if final_msg.stop_reason == "tool_use":
                    # Execute every tool call, collect results
                    tool_results = []
                    for block in final_msg.content:
                        if block.type == "tool_use":
                            tools_used.append(block.name)
                            result = execute_tool(block.name, dict(block.input), agent_name)
                            result_text = json.dumps(result, default=str)
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": result_text,
                            })
                            await websocket.send_json({
                                "type": "tool_result",
                                "name": block.name,
                                "preview": result_text[:120],
                            })

                    # Add assistant + tool results to message history and loop
                    loop_messages.append({"role": "assistant", "content": final_msg.content})
                    loop_messages.append({"role": "user", "content": tool_results})

                else:
                    # No more tool calls â done
                    final_text = full_text
                    break

            agent_histories[conn_key].append({"role": "assistant", "content": final_text})
            _trim_history(conn_key)

            # QC pass: a fast, separate model call reviews this turn's response
            # (and any tools it invoked) for correctness and security red flags
            # — a second, automated check on top of each persona's own
            # "ask before acting" rule, not a replacement for it (destructive
            # tools still require the human's go-ahead in the conversation
            # itself; this just catches things a quick human skim might miss).
            # Never lets a review failure block the actual answer from
            # reaching the user.
            try:
                qc = review_agent_turn(
                    user_message=message, agent_id=agent_name,
                    response_text=final_text, tools_used=tools_used,
                )
                await websocket.send_json({"type": "qc", **qc})
            except Exception:
                _logging.getLogger(__name__).exception("agent QC review failed for %s", agent_name)

            await websocket.send_json({"type": "done", "model": requested_tier})

    except WebSocketDisconnect:
        agent_histories.pop(conn_key, None)
    except Exception as e:
        # Don't leak the provider's raw error (billing JSON, request_id, etc.) to
        # the operator — map it to a friendly message first.
        import logging
        from utils.ai_errors import friendly_ai_error
        logging.getLogger(__name__).exception("agent websocket error for %s", agent_name)
        try:
            await websocket.send_json({"type": "error", "content": friendly_ai_error(e)})
        except Exception:
            pass
        agent_histories.pop(conn_key, None)


# ââ Serve built React frontend (production) ââââââââââââââââââââââââââââââââââââ
_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    # No-cache on the SPA shell only. Vite emits hashed filenames under /assets
    # (e.g. index-a1b2c3d4.js), so those can be cached long-term — but if the
    # browser also caches index.html, it never notices a new bundle exists after
    # a deploy and keeps loading the stale JS. That's the "I merged but the UI
    # still shows the old code" symptom. Forcing revalidation on index.html means
    # every page load picks up the current bundle references without waiting on
    # a hard-refresh or an Incognito window.
    _SPA_NO_CACHE = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("ws/"):
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(_dist / "index.html", headers=_SPA_NO_CACHE)
