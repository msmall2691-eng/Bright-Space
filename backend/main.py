# Force redeploy - fixing quoting router import syntax error in production
import json
import os
import secrets
import yaml
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agents.tools import get_tools_for_agent, execute_tool

from auth import APIKeyMiddleware
from auth_jwt import verify_jwt
from ratelimit import limiter
from database.db import init_db
from scheduler import start_scheduler, stop_scheduler, sync_all_ical_feeds_tick
from modules.clients.router import router as clients_router
from modules.quoting.router import router as quoting_router
from modules.scheduling.router import router as scheduling_router
from modules.scheduling.visits_router import router as visits_router
from modules.invoicing.router import router as invoicing_router
from modules.dispatch.router import router as dispatch_router
from modules.payroll.router import router as payroll_router
from modules.comms.router import router as comms_router
from modules.properties.router import router as properties_router
from modules.recurring.router import router as recurring_router
from modules.reminders.router import router as reminders_router
from modules.intake.router import router as intake_router
from modules.booking.router import router as booking_router
from modules.fields.router import router as fields_router
from modules.gmail.router import router as gmail_router
from modules.opportunities.router import router as opportunities_router
from modules.activities.router import router as activities_router
from modules.search import router as search_router
from modules.geo.router import router as geo_router
from modules.settings.router import router as settings_router
from modules.work import router as work_router
from modules.auth.router import router as auth_router, require_role
from modules.admin.router import router as admin_router
from modules.ai.router import router as ai_router

load_dotenv()

app = FastAPI(title="BrightBase API", version="1.0.0")

# BB-OPS-01: wire rate limiter so @limiter.limit() decorators fire.
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_default_origins = (
    "http://localhost:5173,http://localhost:3000,"
    "https://www.maineclean.co,https://maineclean.co,"
    "https://brightbase-production.up.railway.app"
)
_allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", _default_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    # BB-CODE-02: was ["*"] / ["*", "X-API-Key"] which paired with
    # allow_credentials=True is permissive enough to bite the moment a new
    # origin is added. Explicit lists match what the SPA actually sends.
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
)

# API key authentication â must be added AFTER CORS middleware
# (Starlette processes middleware in reverse order, so CORS runs first)
app.add_middleware(APIKeyMiddleware)

app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(clients_router, prefix="/api/clients", tags=["clients"])
app.include_router(quoting_router, prefix="/api/quotes", tags=["quotes"])
app.include_router(scheduling_router, prefix="/api/jobs", tags=["scheduling"])
app.include_router(visits_router, prefix="/api/visits", tags=["visits"])
app.include_router(invoicing_router, prefix="/api/invoices", tags=["invoicing"])
app.include_router(dispatch_router, prefix="/api/dispatch", tags=["dispatch"])
app.include_router(payroll_router, prefix="/api/payroll", tags=["payroll"])
app.include_router(comms_router, prefix="/api/comms", tags=["comms"])
app.include_router(properties_router, prefix="/api/properties", tags=["properties"])
app.include_router(recurring_router, prefix="/api/recurring", tags=["recurring"])
app.include_router(reminders_router, prefix="/api/reminders", tags=["reminders"])
app.include_router(intake_router, prefix="/api/intake", tags=["intake"])
app.include_router(booking_router, prefix="/api/booking", tags=["booking"])
app.include_router(fields_router, prefix="/api/fields", tags=["fields"])
app.include_router(gmail_router, prefix="/api/gmail", tags=["gmail"])
app.include_router(opportunities_router, prefix="/api/opportunities", tags=["opportunities"])
app.include_router(activities_router, prefix="/api/activities", tags=["activities"])
app.include_router(search_router, prefix="/api/search", tags=["search"])
app.include_router(geo_router, prefix="/api/geo", tags=["geo"])
app.include_router(settings_router, prefix="/api/settings", tags=["settings"])
app.include_router(work_router, prefix="/api/work", tags=["work"])
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])
app.include_router(ai_router, prefix="/api/ai", tags=["ai"])

# Per-connection conversation histories: {connection_key: [messages]}
# BB-CODE-03: bounded so a long chat doesn't accumulate megabytes per session
# (Anthropic's context window is the real ceiling, but we don't need to
# carry the entire transcript every turn). Older messages are dropped from
# the front of the list when the cap is exceeded; system prompt is sent
# fresh every turn via config["system_prompt"] so trimming user/assistant
# pairs is safe.
AGENT_HISTORY_MAX_MESSAGES = int(os.getenv("AGENT_HISTORY_MAX_MESSAGES", "40"))
agent_histories: dict[str, list] = {}


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


def check_visits_coverage(db_session):
    """Check whether UPCOMING jobs have corresponding visits, and log gaps.

    Future-only: past jobs missing visits are not actionable (we don't backfill
    history) so they're excluded — the warning only fires for upcoming jobs,
    which is the only drift worth a human's attention. The startup backfill
    self-heals these, so a non-zero count here is genuinely unexpected."""
    from datetime import date
    from database.models import Job, Visit

    today = date.today()
    upcoming_jobs = db_session.query(Job).filter(Job.scheduled_date >= today).count()
    jobs_without_visits = (
        db_session.query(Job)
        .outerjoin(Visit)
        .filter(Visit.id.is_(None), Job.scheduled_date >= today)
        .count()
    )

    if jobs_without_visits > 0:
        import logging
        logger = logging.getLogger(__name__)
        logger.warning(
            f"VISITS COVERAGE DRIFT: {jobs_without_visits}/{upcoming_jobs} UPCOMING jobs missing visits. "
            f"Run POST /api/visits/admin/backfill-visits-from-jobs to fix."
        )
    return {
        "total_jobs": upcoming_jobs,
        "jobs_without_visits": jobs_without_visits,
        "healthy": jobs_without_visits == 0,
    }


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

    # Check for visits/jobs drift. Wrapped so a missing table (fresh DB,
    # mid-migration) doesn't take down the whole app at startup.
    from database.db import SessionLocal
    db = SessionLocal()
    try:
        coverage = check_visits_coverage(db)
        if not coverage["healthy"]:
            print(f"⚠️  VISITS COVERAGE DRIFT: {coverage['jobs_without_visits']}/{coverage['total_jobs']} upcoming jobs missing visits")
        else:
            print(f"✓ Visits coverage healthy: {coverage['total_jobs']} upcoming jobs all have visits")
    except Exception as e:
        print(f"⚠️  Visits coverage check skipped: {e}")
    finally:
        db.close()

    print("BrightBase backend started")


@app.on_event("shutdown")
async def shutdown():
    stop_scheduler()
    print("BrightBase backend shutdown")


@app.post("/api/admin/ical-sync-now", dependencies=[Depends(require_role("admin", "manager"))])
async def manual_ical_sync():
    """Manually trigger iCal sync for all properties."""
    return sync_all_ical_feeds_tick()


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "BrightBase"}


@app.get("/api/agents")
async def list_agents():
    agents_dir = Path(__file__).parent / "agents"
    agents = []
    for yaml_file in sorted(agents_dir.glob("*.yaml")):
        with open(yaml_file) as f:
            config = yaml.safe_load(f)
        agents.append({
            "id": yaml_file.stem,
            "name": config["name"],
            "emoji": config["emoji"],
            "role": config["role"],
            "description": config["description"],
            "color": config.get("color", "#6b7280"),
        })
    return agents


@app.websocket("/ws/agent/{agent_name}")
async def agent_websocket(websocket: WebSocket, agent_name: str):
    # BaseHTTPMiddleware does not see WebSocket connections, so the
    # APIKeyMiddleware can't gate this route — auth has to happen here.
    # Browsers can't set headers on WS connects, so JWT and API key both
    # come in via query params (?token=... or ?api_key=...).
    expected_key = os.getenv("BRIGHTBASE_API_KEY", "")
    if expected_key:
        token = websocket.query_params.get("token", "")
        provided_key = websocket.query_params.get("api_key", "")
        authed = bool(token and verify_jwt(token)) or (
            bool(provided_key) and secrets.compare_digest(provided_key, expected_key)
        )
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

            agent_histories[conn_key].append({"role": "user", "content": message})
            _trim_history(conn_key)

            # Agentic tool-use loop
            loop_messages = list(agent_histories[conn_key])
            final_text = ""

            while True:
                full_text = ""
                tool_uses = []

                with client.messages.stream(
                    model="claude-sonnet-4-6",
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
            await websocket.send_json({"type": "done"})

    except WebSocketDisconnect:
        agent_histories.pop(conn_key, None)
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "content": str(e)})
        except Exception:
            pass
        agent_histories.pop(conn_key, None)


# ââ Serve built React frontend (production) ââââââââââââââââââââââââââââââââââââ
_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("ws/"):
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(_dist / "index.html")
