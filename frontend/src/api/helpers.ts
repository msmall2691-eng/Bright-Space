/**
 * Ergonomic re-exports of OpenAPI-generated types.
 *
 * Run `npm run gen:types` to refresh `types.ts` from the live FastAPI schema
 * (the script imports `main:app` and dumps `app.openapi()`).
 *
 * Today most GET endpoints return `unknown` because their Python handlers
 * return `list[dict]` — see step 2 of the typing rollout (add `response_model=`
 * to the route to make the schema concrete). The request bodies (JobCreate,
 * ScheduleCreate, ExceptionCreate, etc.) are already typed via Pydantic.
 */
import type { components, paths } from './types'

// Request body schemas — driven by Pydantic models in the backend.
export type JobCreate = components['schemas']['JobCreate']
export type JobUpdate = components['schemas']['JobUpdate']
export type ScheduleCreate = components['schemas']['ScheduleCreate']
export type ScheduleUpdate = components['schemas']['ScheduleUpdate']
export type ExceptionCreate = components['schemas']['ExceptionCreate']
export type VisitRead = components['schemas']['VisitRead']

// Response shapes — added in Phase 6 step 2 by attaching `response_model=`
// to the hot routes. The short alias name (`Job`, `RecurrenceException`)
// is the consumer-facing handle.
export type Job = components['schemas']['JobResponse']
export type Booking = components['schemas']['BookingInfo']
export type RecurrenceException = components['schemas']['RecurrenceExceptionRead']

// Re-export the path map for advanced consumers (`Paths['/api/jobs']`).
export type Paths = paths
export type Schemas = components['schemas']
