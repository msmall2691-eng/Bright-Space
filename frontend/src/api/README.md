# API types

`types.ts` is auto-generated from the FastAPI app's OpenAPI schema.
**Don't edit it by hand** — re-run the codegen script.

## Regenerate

```bash
npm run gen:types
```

The script:
1. `cd ../backend && python -c "import json; from main import app; print(json.dumps(app.openapi()))"` — extracts the OpenAPI schema directly from the running app object (no live server needed).
2. Writes the schema to `src/api/openapi.json` (gitignored).
3. Runs `openapi-typescript` to emit `src/api/types.ts`.

Re-run after any backend change that touches a route handler signature, response shape, or Pydantic model.

## Consume

```ts
import type { JobCreate, ScheduleUpdate } from '@/api/helpers'
import type { paths } from '@/api/types'

// Path-driven type:
type ListJobsResponse =
  paths['/api/jobs']['get']['responses']['200']['content']['application/json']
```

## Known gaps

GET responses currently return `unknown` for endpoints whose handlers return `list[dict]` rather than a Pydantic `response_model`. Step 2 of the typing rollout will add `response_model=` to the hot routes (`/api/jobs`, `/api/recurring`, `/api/visits`) so consumers get concrete types. Today's typed surface is mostly request bodies + a few endpoints that already use Pydantic models.
