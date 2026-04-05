"""
Tool definitions and execution for BrightBase agents.

Business tools  → all agents
Codebase tools  → Pixel only
Action tools    → all agents (trigger real operations)
"""
import glob as glob_module
import json
import os
import re
from datetime import date, timedelta
from pathlib import Path

BRIGHTBASE_ROOT = Path("C:/BrightBase").resolve()

# ── Tool schemas ───────────────────────────────────────────────────────────────

TOOLS_BUSINESS = [
    {
        "name": "get_business_snapshot",
        "description": "Live snapshot: client counts, today's jobs, upcoming jobs, active recurring schedules, outstanding invoices.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_clients",
        "description": "List clients with status, city, phone. Filter by status: lead | active | inactive.",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["lead", "active", "inactive"]},
            },
        },
    },
    {
        "name": "get_jobs",
        "description": "List jobs filtered by date range, status, or job type. Returns client name, date, time, address.",
        "input_schema": {
            "type": "object",
            "properties": {
                "date_from":  {"type": "string", "description": "YYYY-MM-DD"},
                "date_to":    {"type": "string", "description": "YYYY-MM-DD"},
                "status":     {"type": "string", "enum": ["scheduled", "in_progress", "completed", "cancelled"]},
                "job_type":   {"type": "string", "enum": ["residential", "commercial", "str_turnover"]},
            },
        },
    },
    {
        "name": "get_recurring_schedules",
        "description": "List all recurring schedules with client name, frequency, day, time, and whether jobs have been generated.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "check_system_health",
        "description": "Diagnose BrightBase configuration: Google Calendar auth, Twilio, database, unpushed jobs, missing data.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "run_operation",
        "description": (
            "Trigger a BrightBase operation. Operations: "
            "'generate_all_jobs' (generate visits for all active recurring schedules), "
            "'push_all_to_gcal' (push all unpushed upcoming jobs to Google Calendar), "
            "'sync_all_ical' (re-sync all STR Airbnb iCal feeds)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["generate_all_jobs", "push_all_to_gcal", "sync_all_ical"],
                },
            },
            "required": ["operation"],
        },
    },
]

TOOLS_PIXEL = TOOLS_BUSINESS + [
    {
        "name": "read_file",
        "description": "Read any file in the BrightBase codebase. Use paths like 'backend/main.py' or 'frontend/src/pages/Scheduling.jsx'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to C:\\BrightBase\\"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_files",
        "description": "List files in a BrightBase directory. Skips node_modules, venv, __pycache__.",
        "input_schema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string", "description": "Directory relative to C:\\BrightBase\\ e.g. 'backend/modules'"},
                "pattern":   {"type": "string", "description": "File pattern e.g. '*.py' or '*.jsx'. Default: '*'"},
            },
        },
    },
    {
        "name": "search_code",
        "description": "Search for a string or pattern across BrightBase source files. Returns matching lines with file and line number.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query":    {"type": "string", "description": "Text or regex to search for"},
                "pattern":  {"type": "string", "description": "Glob file pattern e.g. '*.py' or '*.jsx'. Default searches all"},
                "directory": {"type": "string", "description": "Limit search to this directory e.g. 'backend/modules'"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "write_file",
        "description": (
            "Write or overwrite a file in the BrightBase codebase. "
            "Use this to implement new features, create new modules, or fully rewrite a file. "
            "Always read_file first on existing files before overwriting."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path":    {"type": "string", "description": "Path relative to C:\\BrightBase\\ e.g. 'backend/modules/foo/router.py'"},
                "content": {"type": "string", "description": "Full file content to write"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": (
            "Make a targeted edit to an existing file — finds old_string and replaces it with new_string. "
            "Safer than write_file for small changes. Fails if old_string is not found exactly. "
            "Use read_file first to confirm the exact text."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path":       {"type": "string", "description": "Path relative to C:\\BrightBase\\"},
                "old_string": {"type": "string", "description": "Exact string to find (must be unique in the file)"},
                "new_string": {"type": "string", "description": "Replacement string"},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    {
        "name": "run_command",
        "description": (
            "Run a shell command inside the BrightBase backend directory. "
            "Allowed: python scripts, pip install, checking DB with sqlite3, running tests. "
            "Not allowed: git push, rm/del, anything outside C:\\BrightBase. "
            "Returns stdout and stderr. Timeout: 30 seconds."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Command to run e.g. 'python migrate.py' or 'pip install httpx'"},
            },
            "required": ["command"],
        },
    },
]


def get_tools_for_agent(agent_name: str) -> list:
    # All agents get the full toolset — business data + codebase read/write
    return TOOLS_PIXEL


# ── Tool execution ─────────────────────────────────────────────────────────────

def execute_tool(name: str, input_data: dict, agent_name: str = "") -> dict:
    from database.db import SessionLocal
    from database.models import Client, Job, RecurringSchedule, Property, Invoice, ICalEvent

    db = SessionLocal()
    try:

        # ── Business data ──────────────────────────────────────────────────────

        if name == "get_business_snapshot":
            today = date.today().isoformat()
            week_end = (date.today() + timedelta(days=7)).isoformat()
            return {
                "date_today": today,
                "clients_total":  db.query(Client).count(),
                "clients_active": db.query(Client).filter(Client.status == "active").count(),
                "clients_leads":  db.query(Client).filter(Client.status == "lead").count(),
                "jobs_today":     db.query(Job).filter(Job.scheduled_date == today).count(),
                "jobs_this_week": db.query(Job).filter(
                    Job.scheduled_date >= today, Job.scheduled_date <= week_end,
                    Job.status == "scheduled"
                ).count(),
                "jobs_upcoming_total": db.query(Job).filter(
                    Job.scheduled_date >= today, Job.status == "scheduled"
                ).count(),
                "jobs_not_on_gcal": db.query(Job).filter(
                    Job.scheduled_date >= today,
                    Job.status == "scheduled",
                    Job.calendar_invite_sent == False,
                ).count(),
                "active_recurring_schedules": db.query(RecurringSchedule).filter(RecurringSchedule.active == True).count(),
                "str_properties": db.query(Property).filter(Property.property_type == "str", Property.active == True).count(),
                "outstanding_invoices": sum(
                    i.total or 0
                    for i in db.query(Invoice).filter(Invoice.status.in_(["sent", "overdue"])).all()
                ),
            }

        elif name == "get_clients":
            q = db.query(Client)
            if input_data.get("status"):
                q = q.filter(Client.status == input_data["status"])
            return [
                {"id": c.id, "name": c.name, "status": c.status, "city": c.city,
                 "phone": c.phone, "email": c.email, "source": c.source}
                for c in q.order_by(Client.name).limit(100).all()
            ]

        elif name == "get_jobs":
            q = db.query(Job)
            if input_data.get("date_from"): q = q.filter(Job.scheduled_date >= input_data["date_from"])
            if input_data.get("date_to"):   q = q.filter(Job.scheduled_date <= input_data["date_to"])
            if input_data.get("status"):    q = q.filter(Job.status == input_data["status"])
            if input_data.get("job_type"):  q = q.filter(Job.job_type == input_data["job_type"])
            client_map = {c.id: c.name for c in db.query(Client).all()}
            return [
                {
                    "id": j.id, "title": j.title,
                    "client": client_map.get(j.client_id, f"#{j.client_id}"),
                    "date": j.scheduled_date, "start": j.start_time, "end": j.end_time,
                    "type": j.job_type, "status": j.status, "address": j.address,
                    "on_gcal": j.calendar_invite_sent,
                    "recurring": j.recurring_schedule_id is not None,
                }
                for j in q.order_by(Job.scheduled_date, Job.start_time).limit(100).all()
            ]

        elif name == "get_recurring_schedules":
            client_map = {c.id: c.name for c in db.query(Client).all()}
            day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            today = date.today().isoformat()
            result = []
            for s in db.query(RecurringSchedule).all():
                upcoming = db.query(Job).filter(
                    Job.recurring_schedule_id == s.id,
                    Job.scheduled_date >= today
                ).count()
                unpushed = db.query(Job).filter(
                    Job.recurring_schedule_id == s.id,
                    Job.scheduled_date >= today,
                    Job.calendar_invite_sent == False,
                ).count()
                result.append({
                    "id": s.id, "title": s.title,
                    "client": client_map.get(s.client_id, f"#{s.client_id}"),
                    "type": s.job_type, "frequency": s.frequency,
                    "day": day_names[s.day_of_week] if 0 <= s.day_of_week <= 6 else "?",
                    "time": f"{s.start_time}–{s.end_time}",
                    "active": s.active,
                    "upcoming_jobs": upcoming,
                    "not_on_gcal": unpushed,
                })
            return result

        elif name == "check_system_health":
            today = date.today().isoformat()
            issues = []
            ok = []

            # Google Calendar auth
            token_path = BRIGHTBASE_ROOT / "backend" / "google_token.json"
            if token_path.exists():
                ok.append("Google Calendar token file exists")
            else:
                issues.append("CRITICAL: google_token.json missing — run auth_google.py")

            # Env vars
            gcal_id = os.getenv("GCAL_RESIDENTIAL_ID", "")
            twilio_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
            anthropic_key = os.getenv("ANTHROPIC_API_KEY", "")
            if gcal_id: ok.append(f"Google Calendar ID configured: {gcal_id}")
            else: issues.append("GCAL_RESIDENTIAL_ID not set in .env")
            if twilio_sid: ok.append("Twilio configured")
            else: issues.append("TWILIO_ACCOUNT_SID not set in .env")
            if anthropic_key: ok.append("Anthropic API key present")
            else: issues.append("ANTHROPIC_API_KEY missing")

            # Upcoming jobs not on GCal
            unpushed = db.query(Job).filter(
                Job.scheduled_date >= today,
                Job.status == "scheduled",
                Job.calendar_invite_sent == False,
            ).count()
            if unpushed:
                issues.append(f"{unpushed} upcoming jobs NOT pushed to Google Calendar")
            else:
                ok.append("All upcoming jobs are on Google Calendar")

            # Recurring schedules with no upcoming jobs
            active_scheds = db.query(RecurringSchedule).filter(RecurringSchedule.active == True).all()
            for s in active_scheds:
                count = db.query(Job).filter(
                    Job.recurring_schedule_id == s.id,
                    Job.scheduled_date >= today
                ).count()
                if count == 0:
                    issues.append(f"Recurring schedule '{s.title}' has 0 upcoming jobs generated")

            # STR properties without recent iCal sync
            str_props = db.query(Property).filter(
                Property.property_type == "str",
                Property.ical_url != None,
                Property.active == True
            ).all()
            for p in str_props:
                if not p.ical_last_synced_at:
                    issues.append(f"STR property '{p.name}' has never been synced")

            # Clients with no jobs or schedules
            active_clients = db.query(Client).filter(Client.status == "active").count()
            clients_with_jobs = db.query(Job.client_id).distinct().count()

            return {
                "status": "issues_found" if issues else "healthy",
                "ok": ok,
                "issues": issues,
                "stats": {
                    "active_clients": active_clients,
                    "clients_with_jobs": clients_with_jobs,
                    "active_recurring_schedules": len(active_scheds),
                    "upcoming_jobs_not_on_gcal": unpushed,
                }
            }

        # ── Action tools ───────────────────────────────────────────────────────

        elif name == "run_operation":
            op = input_data.get("operation", "")

            if op == "generate_all_jobs":
                from modules.recurring.router import generate_jobs
                schedules = db.query(RecurringSchedule).filter(RecurringSchedule.active == True).all()
                total = 0
                results = []
                for s in schedules:
                    count = generate_jobs(db, s)
                    total += count
                    results.append({"schedule": s.title, "jobs_created": count})
                return {"operation": op, "schedules_processed": len(schedules), "total_jobs_created": total, "details": results}

            elif op == "push_all_to_gcal":
                from integrations.google_calendar import create_event
                today = date.today().isoformat()
                jobs = db.query(Job).filter(
                    Job.scheduled_date >= today,
                    Job.status == "scheduled",
                    Job.calendar_invite_sent == False,
                ).all()
                client_map = {c.id: c for c in db.query(Client).all()}
                pushed, failed = 0, 0
                for j in jobs:
                    c = client_map.get(j.client_id)
                    job_dict = {"id": j.id, "title": j.title, "job_type": j.job_type or "residential",
                                "scheduled_date": j.scheduled_date, "start_time": j.start_time,
                                "end_time": j.end_time, "address": j.address, "notes": j.notes}
                    client_dict = {"name": c.name if c else "", "email": c.email if c else None}
                    try:
                        eid = create_event(job_dict, client_dict)
                        if eid:
                            j.calendar_invite_sent = True
                            pushed += 1
                        else:
                            failed += 1
                    except Exception:
                        failed += 1
                db.commit()
                return {"operation": op, "pushed": pushed, "failed": failed}

            elif op == "sync_all_ical":
                from integrations.ical_sync import sync_property
                props = db.query(Property).filter(
                    Property.active == True,
                    Property.ical_url != None,
                ).all()
                results = []
                for p in props:
                    r = sync_property(db, p)
                    results.append(r)
                return {"operation": op, "properties_synced": len(results), "results": results}

            else:
                return {"error": f"Unknown operation: {op}"}

        # ── Pixel codebase tools ───────────────────────────────────────────────

        elif name == "read_file":
            path_str = input_data.get("path", "").replace("\\", "/").lstrip("/")
            target = (BRIGHTBASE_ROOT / path_str).resolve()
            if not str(target).startswith(str(BRIGHTBASE_ROOT)):
                return {"error": "Access denied — path outside BrightBase"}
            if not target.exists():
                return {"error": f"File not found: {path_str}"}
            if not target.is_file():
                return {"error": f"Not a file: {path_str}"}
            if target.stat().st_size > 100_000:
                return {"error": "File too large (>100KB). Use search_code to find specific sections."}
            content = target.read_text(encoding="utf-8", errors="replace")
            lines = content.splitlines()
            numbered = "\n".join(f"{i+1:4}: {l}" for i, l in enumerate(lines))
            return {"path": path_str, "lines": len(lines), "content": numbered}

        elif name == "list_files":
            directory = (input_data.get("directory") or "").replace("\\", "/").lstrip("/")
            pattern = input_data.get("pattern") or "*"
            target_dir = (BRIGHTBASE_ROOT / directory).resolve() if directory else BRIGHTBASE_ROOT
            if not str(target_dir).startswith(str(BRIGHTBASE_ROOT)):
                return {"error": "Access denied"}
            SKIP = {"node_modules", "venv", "__pycache__", ".git", "dist", ".venv", "coverage"}
            files = []
            for f in glob_module.glob(str(target_dir / "**" / pattern), recursive=True):
                p = Path(f)
                if any(part in SKIP for part in p.parts) or not p.is_file():
                    continue
                files.append(str(p.relative_to(BRIGHTBASE_ROOT)).replace("\\", "/"))
            return {"directory": directory or ".", "pattern": pattern, "files": sorted(files)[:200]}

        elif name == "write_file":
            import subprocess
            path_str = input_data.get("path", "").replace("\\", "/").lstrip("/")
            target = (BRIGHTBASE_ROOT / path_str).resolve()
            if not str(target).startswith(str(BRIGHTBASE_ROOT)):
                return {"error": "Access denied — path outside BrightBase"}
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(input_data.get("content", ""), encoding="utf-8")
            return {"success": True, "path": path_str, "bytes_written": target.stat().st_size}

        elif name == "edit_file":
            path_str = input_data.get("path", "").replace("\\", "/").lstrip("/")
            target = (BRIGHTBASE_ROOT / path_str).resolve()
            if not str(target).startswith(str(BRIGHTBASE_ROOT)):
                return {"error": "Access denied — path outside BrightBase"}
            if not target.exists():
                return {"error": f"File not found: {path_str}"}
            old_string = input_data.get("old_string", "")
            new_string = input_data.get("new_string", "")
            content = target.read_text(encoding="utf-8", errors="replace")
            if old_string not in content:
                # Show nearby content to help debug
                snippet = content[:500] if len(content) < 500 else content[:500] + "..."
                return {"error": f"old_string not found in {path_str}. File starts with:\n{snippet}"}
            count = content.count(old_string)
            if count > 1:
                return {"error": f"old_string appears {count} times — make it more specific to ensure unique match"}
            new_content = content.replace(old_string, new_string, 1)
            target.write_text(new_content, encoding="utf-8")
            return {"success": True, "path": path_str, "replacements": 1}

        elif name == "run_command":
            import subprocess, shlex
            command = input_data.get("command", "").strip()
            # Safety: block destructive or out-of-scope commands
            blocked = ["git push", "git reset", "rm ", "del ", "rmdir", "format", "shutdown", "DROP TABLE", ":(){"]
            for b in blocked:
                if b.lower() in command.lower():
                    return {"error": f"Command blocked for safety: contains '{b}'"}
            backend_dir = BRIGHTBASE_ROOT / "backend"
            venv_python = BRIGHTBASE_ROOT / "backend" / "venv" / "Scripts" / "python.exe"
            # Use venv python for python commands
            if command.startswith("python "):
                command = command.replace("python ", str(venv_python) + " ", 1)
            elif command.startswith("pip "):
                pip_path = BRIGHTBASE_ROOT / "backend" / "venv" / "Scripts" / "pip.exe"
                command = command.replace("pip ", str(pip_path) + " ", 1)
            try:
                result = subprocess.run(
                    command, shell=True, capture_output=True, text=True,
                    timeout=30, cwd=str(backend_dir)
                )
                return {
                    "command": command,
                    "returncode": result.returncode,
                    "stdout": result.stdout[-3000:] if result.stdout else "",
                    "stderr": result.stderr[-2000:] if result.stderr else "",
                    "success": result.returncode == 0,
                }
            except subprocess.TimeoutExpired:
                return {"error": "Command timed out after 30 seconds"}

        elif name == "search_code":
            query = input_data.get("query", "")
            pattern = input_data.get("pattern") or "*"
            directory = (input_data.get("directory") or "").replace("\\", "/").lstrip("/")
            target_dir = (BRIGHTBASE_ROOT / directory).resolve() if directory else BRIGHTBASE_ROOT
            if not str(target_dir).startswith(str(BRIGHTBASE_ROOT)):
                return {"error": "Access denied"}
            SKIP = {"node_modules", "venv", "__pycache__", ".git", "dist", ".venv"}
            matches = []
            try:
                rx = re.compile(query, re.IGNORECASE)
            except re.error:
                rx = re.compile(re.escape(query), re.IGNORECASE)
            for f in glob_module.glob(str(target_dir / "**" / pattern), recursive=True):
                p = Path(f)
                if any(part in SKIP for part in p.parts) or not p.is_file():
                    continue
                try:
                    for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                        if rx.search(line):
                            rel = str(p.relative_to(BRIGHTBASE_ROOT)).replace("\\", "/")
                            matches.append({"file": rel, "line": i, "text": line.strip()})
                            if len(matches) >= 60:
                                break
                except Exception:
                    pass
                if len(matches) >= 60:
                    break
            return {"query": query, "matches": len(matches), "results": matches}

        else:
            return {"error": f"Unknown tool: {name}"}

    except Exception as e:
        return {"error": str(e)}
    finally:
        db.close()
