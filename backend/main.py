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

from database.db import init_db
from modules.clients.router import router as clients_router
from modules.quoting.router import router as quoting_router
from modules.scheduling.router import router as scheduling_router
from modules.invoicing.router import router as invoicing_router
from modules.dispatch.router import router as dispatch_router
from modules.payroll.router import router as payroll_router
from modules.comms.router import router as comms_router
from modules.properties.router import router as properties_router
from modules.recurring.router import router as recurring_router
from modules.reminders.router import router as reminders_router
from modules.intake.router import router as intake_router
from modules.fields.router import router as fields_router
from modules.scheduling.scheduler_router import router as scheduler_router

load_dotenv()

app = FastAPI(title="BrightBase API", version="1.0.0")

_default_origins = "http://localhost:5173,http://localhost:3000,https://www.maineclean.co,https://maineclean.co"
_allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", _default_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(clients_router, prefix="/api/clients", tags=["clients"])
app.include_router(quoting_router, prefix="/api/quotes", tags=["quotes"])
app.include_router(scheduling_router, prefix="/api/jobs", tags=["scheduling"])
app.include_router(invoicing_router, prefix="/api/invoices", tags=["invoicing"])
app.include_router(dispatch_router, prefix="/api/dispatch", tags=["dispatch"])
app.include_router(payroll_router, prefix="/api/payroll", tags=["payroll"])
app.include_router(comms_router, prefix="/api/comms", tags=["comms"])
app.include_router(properties_router, prefix="/api/properties", tags=["properties"])
app.include_router(recurring_router, prefix="/api/recurring", tags=["recurring"])
app.include_router(reminders_router, prefix="/api/reminders", tags=["reminders"])
app.include_router(intake_router, prefix="/api/intake", tags=["intake"])
app.include_router(fields_router, prefix="/api/fields", tags=["fields"])
app.include_router(scheduler_router, prefix="/api/scheduler", tags=["scheduler"])

# Per-connection conversation histories: {connection_key: [messages]}
agent_histories: dict[str, list] = {}


def load_agent_config(agent_name: str) -> dict:
    config_path = Path(__file__).parent / "agents" / f"{agent_name}.yaml"
    if not config_path.exists():
        raise ValueError(f"Agent '{agent_name}' not found")
    with open(config_path) as f:
        return yaml.safe_load(f)


@app.on_event("startup")
async def startup():
    init_db()
    # Start background scheduler for automated tasks
    from scheduler import start_scheduler
    start_scheduler()
    print("BrightBase backend started (scheduler active)")


@app.on_event("shutdown")
async def shutdown():
    from scheduler import stop_scheduler
    stop_scheduler()


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
                    # No more tool calls — done
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


# ── Serve built React frontend (production) ────────────────────────────────────
_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        return FileResponse(_dist / "index.html")
