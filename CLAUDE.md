# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## What this is

**BrightBase** (repo: Bright-Space, API title `BrightBase API`) is the operations
hub for **The Maine Cleaning Co.** — a full-stack app that runs a cleaning
business end to end. The core domain is the operational pipeline:

**Request → Quote → Accept → Schedule/Job → Dispatch → Complete → Invoice → Paid → Recurring.**

`docs/workflow-map.md` is the authoritative, code-grounded walkthrough of that
pipeline (which endpoints, which models, where behavior diverges from the
obvious story). Read it before making changes that touch more than one stage.

The app is **multi-tenant** (org-scoped) with Postgres Row-Level Security as the
last line of isolation — see [Multi-tenancy](#multi-tenancy-mt-3) below.

## Stack

- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2.0 (ORM), Alembic (migrations),
  APScheduler (background jobs), Anthropic SDK (AI agents). Served by uvicorn.
- **Frontend:** React 18 + Vite 8, React Router 6, Tailwind CSS 3, Vitest.
  Plain JS/JSX (no TypeScript in app code, though types are generated from the
  OpenAPI schema — see below).
- **Database:** Postgres in production (SQLite only for local dev / tests).
- **Deploy:** Docker → Railway. Frontend is built and served as static files by
  the backend (single container).
- **Integrations:** Twilio (SMS), Gmail/SMTP (email), Google Calendar, Connecteam
  (field crew scheduling), Square (payments), iCal feeds, Web Push.

## Repository layout

```
backend/
  main.py            FastAPI app: middleware, router wiring, WebSocket, startup
  scheduler.py       APScheduler background jobs (large: recurring gen, syncs)
  config.py          Env/config resolution (CORS origins, base URLs, company)
  auth.py            APIKeyMiddleware (X-API-Key for server-to-server)
  auth_jwt.py        JWT issue/verify/refresh (sliding sessions)
  ratelimit.py       slowapi limiter + rate_limit helper
  database/
    db.py            Engine, SessionLocal, get_db, schema-drift check
    base.py          Declarative Base
    models.py        All SQLAlchemy models (single file)
    rls.py           Postgres Row-Level Security policies (MT-3)
  modules/<domain>/  Feature modules, each a FastAPI router (see below)
  integrations/      External-service clients (twilio, gcal, gmail, square, ...)
  services/          Cross-module business services (email, pdf, push, dunning)
  agents/            AI agent roster: *.yaml personas + tools.py
  schemas/           Pydantic request/response schemas
  utils/             Shared helpers (dates, address, integration_log, ...)
  alembic/versions/  Migrations (66+ revisions)
  scripts/           Ops scripts; db_bootstrap.py runs pre-deploy
  tests/             Primary test suite (shared fixtures via conftest.py)
  test_*.py          A few root-level tests that bypass the auth autouse fixture
frontend/
  src/
    main.jsx, App.jsx  Entry + router
    api.js             Centralized fetch client (JWT Bearer auth)
    api/               Generated OpenAPI types (types.ts, openapi.json)
    pages/             Route-level screens (Dashboard, Clients, Schedule, ...)
    components/        Reusable UI, grouped by domain + components/ui primitives
    hooks/, utils/     With __tests__/ alongside
docs/                Design/audit/plan docs — workflow-map.md is the map
.github/workflows/ci.yml   CI: backend tests, RLS/Postgres, frontend build
Dockerfile, railway.json   Build + deploy config
```

### Backend modules (`backend/modules/`)

Each subdirectory is a self-contained feature module exposing a FastAPI
`router` that `main.py` mounts. Domains include: `auth`, `clients`,
`properties`, `quoting`, `scheduling`, `dispatch`, `invoicing`, `payroll`,
`booking`, `intake`, `opportunities`, `recurring`, `reminders`, `comms`,
`connecteam`, `gmail`, `geo`, `search`, `views`, `dashboard`, `portal`,
`push`, `admin`, `ai`, `activities`, `integration_events`, `integrations`,
`fields`, `settings`.

**Module convention:** a router (`router.py`) that reads/writes via
`Session = Depends(get_db)`, scopes queries with the org/auth dependencies from
`modules/auth/router.py`, and returns **plain dicts** (not ORM objects) so the
wire shape is decoupled from the DB. See `modules/quoting/router.py` for the
canonical pattern (`_quote_dict`, `require_role`, `current_org_id`).

## Development workflows

### Backend

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt   # dev adds pytest/mypy
cp .env.example .env                                       # fill in secrets
# DATABASE_URL is REQUIRED (no default). For local dev/tests use sqlite:
#   DATABASE_URL=sqlite:///./local.db
uvicorn main:app --reload
```

- **JWT_SECRET and DATABASE_URL are read at import time and fail closed if
  unset** — the app refuses to start without them. `load_dotenv()` runs at the
  very top of `main.py` before any local import for this reason; don't move it.
- **Migrations:** Alembic. `python scripts/db_bootstrap.py` is the pre-deploy
  command (applies migrations + RLS to a fresh or existing DB). Add new
  revisions under `alembic/versions/`.

### Frontend

```bash
cd frontend
npm install
npm run dev        # Vite dev server
npm run build      # production build (what CI and Docker run)
npm run test       # Vitest
npm run gen:types  # regenerate src/api/types.ts from the backend OpenAPI schema
```

Run `npm run gen:types` after changing backend request/response shapes so the
generated API types stay in sync.

### Tests

```bash
# Backend — CI runs the curated set enumerated in backend/pytest.ini:
cd backend && python -m pytest
python -m pytest test_placeholder_absorption.py   # separate: bootstraps own DB

# Frontend:
cd frontend && npm run test
```

- New backend tests go under `backend/tests/` (they share fixtures via
  `tests/conftest.py`: schema-per-session + auto API-key injection). The few
  root-level `test_*.py` files intentionally sit outside `tests/` to bypass the
  auth autouse fixture — don't add there without reason.
- `pytest.ini` `testpaths` is a **curated, vetted-green list**. Add new
  shareable test files under `tests/` and, if they should gate CI, list them.

### Type checking (optional, not gated)

mypy covers `modules/scheduling/` and `modules/recurring/` only. Run
`mypy --config-file mypy.ini` from `backend/`. See `backend/TYPING.md`.

## CI (`.github/workflows/ci.yml`)

Runs on every PR and push to `main`. Three jobs — all must pass:
1. **Backend tests** — the curated pytest set + isolated placeholder-absorption.
2. **RLS (Postgres)** — spins up Postgres 16, validates multi-tenant RLS
   (`tests/test_tenancy_rls_postgres.py`) and that migrations replay cleanly
   from an empty DB (`tests/test_migrations_from_scratch.py`).
3. **Frontend build** — `npm ci && npm run build`.

## Key conventions & guardrails

- **Multi-tenancy (MT-3):** every tenant table carries `org_id`. Queries must be
  org-scoped via the auth dependencies. Postgres RLS in `database/rls.py` is the
  backstop — it reads `app.current_org_id` (a per-transaction GUC set by the
  `current_org_id` dependency); unset → policy is a no-op (background jobs,
  migrations). When adding a tenant table, add it to `TENANT_TABLES` in
  `rls.py` **and** cover it with a tenancy-scope test.
- **Auth:** the SPA uses **JWT only** (Bearer token in `Authorization`, stored in
  localStorage). `X-API-Key` still works for server-to-server callers but the
  browser must never carry the master key. Sessions slide: a token past its
  half-life is rotated back via the `X-Refresh-Token` response header.
- **API responses:** return plain dicts from routers, not ORM objects.
- **Rate limiting:** per-IP via slowapi; the app runs behind Railway's proxy, so
  `--proxy-headers --forwarded-allow-ips="*"` is required for per-IP limits to
  work (see Dockerfile CMD).
- **Intake dedup:** lead intake has idempotency-key + 5-minute dedup + Postgres
  advisory locks. Don't bypass `build_intake()`/`upsert_lead()`
  (`modules/intake/normalize.py`) — all three public intake endpoints funnel
  through it.
- **CORS:** production origins (e.g. maineclean.co) are force-merged in
  `config.resolve_cors_origins` so a partial `ALLOWED_ORIGINS` override can't
  silently drop inbound website leads.
- Many non-obvious decisions are documented inline with `BB-*` tags (e.g.
  `BB-INFRA-01`, `BB-CODE-02`) and PR references — read the surrounding comment
  before "fixing" something that looks odd; it's usually load-bearing.

## AI agents (`backend/agents/`)

Persona-driven Claude agents defined as YAML (`finn`, `mia`, `nova`, `pixel`,
`scout`, plus a `deploy` config). Each has a `system_prompt`, a curated tool set
(`agents/tools.py`: business-data reads, codebase read/search, and gated
write/run tools), and is served through `modules/ai/router.py`
(`review_agent_turn`, WebSocket-driven). Agents can read the codebase but are
prompted to **ask before any write/edit/command**.

## Deployment

Docker multi-stage build (Node builds the frontend → Python serves it). Railway
uses `railway.json`: `preDeployCommand` runs `scripts/db_bootstrap.py`
(migrations + RLS), health check at `/api/health`, uvicorn with
`UVICORN_WORKERS` (default 4) workers. Frontend `dist/` is copied into the
backend image and served as static files.

## Git / contribution

- Feature work happens on branches; don't push directly to `main`.
- Do **not** open a pull request unless explicitly asked.
- Keep changes scoped and covered by tests in the curated CI set where it makes
  sense. When you touch backend shapes, regenerate frontend types.
