import json
import os
import yaml
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agents.tools import get_tools_for_agent, execute_tool

from auth import APIKeyMiddleware
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
from modules.settings.router import router as settings_router
from modules.work import router as work_router
from modules.auth.router import router as auth_router
from modules.admin.router import router as admin_router

load_dotenv()

app = FastAPI(title="BrightBase API", version="1.0.0")

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
    allow_methods=["*"],
    allow_headers=["*", "X-API-Key"],
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
app.include_router(settings_router, prefix="/api/settings", tags=["settings"])
app.include_router(work_router, prefix="/api/work", tags=["work"])
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])

# Per-connection conversation histories: {connection_key: [messages]}
agent_histories: dict[str, list] = {}


def load_agent_config(agent_name: str) -> dict:
    config_path = Path(__file__).parent / "agents" / f"{agent_name}.yaml"
    if not config_path.exists():
        raise ValueError(f"Agent '{agent_name}' not found")
    with open(config_path) as f:
        return yaml.safe_load(f)


def check_visits_coverage(db_session):
    """Check if all jobs have corresponding visits. Logs discrepancies."""
    from database.models import Job, Visit

    total_jobs = db_session.query(Job).count()
    total_visits = db_session.query(Visit).count()
    jobs_without_visits = db_session.query(Job).outerjoin(Visit).filter(Visit.id.is_(None)).count()

    if jobs_without_visits > 0:
        import logging
        logger = logging.getLogger(__name__)
        logger.warning(
            f"VISITS COVERAGE DRIFT: {jobs_without_visits}/{total_jobs} jobs missing visits. "
            f"Total jobs={total_jobs}, Total visits={total_visits}. "
            f"Run POST /api/visits/admin/backfill-visits-from-jobs to fix."
        )
    return {
        "total_jobs": total_jobs,
        "total_visits": total_visits,
        "jobs_without_visits": jobs_without_visits,
        "healthy": jobs_without_visits == 0
    }


@app.on_event("startup")
async def startup():
    init_db()
    start_scheduler()

    # Check for visits/jobs drift
    from database.db import SessionLocal
    db = SessionLocal()
    try:
        coverage = check_visits_coverage(db)
        if not coverage["healthy"]:
            print(f"⚠️  VISITS COVERAGE DRIFT: {coverage['jobs_without_visits']}/{coverage['total_jobs']} jobs missing visits")
        else:
            print(f"✓ Visits coverage healthy: {coverage['total_jobs']} jobs, {coverage['total_visits']} visits")
    finally:
        db.close()

    print("BrightBase backend started")


@app.on_event("shutdown")
async def shutdown():
    stop_scheduler()
    print("BrightBase backend shutdown")


@app.post("/api/admin/ical-sync-now")
async def manual_ical_sync():
    """Manually trigger iCal sync for all properties."""
    return sync_all_ical_feeds_tick()


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "BrightBase"}


@app.get("/api/config")
async def get_config():
    """Public endpoint that provides the API key to the SPA frontend."""
    return {"api_key": os.getenv("BRIGHTBASE_API_KEY", "")}


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
        return FileResponse(_dist / "index.html")
