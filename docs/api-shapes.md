# API Response Shapes

Tracking the response shape of each collection endpoint so the next developer
doesn't have to grep to figure out which shape a call site should expect.

Issue #90 flags the inconsistency: `/api/visits` returns an envelope, `/api/jobs`
returns a raw array, `/api/properties/N` returns a single object. The
recommendation there — and what this document pins — is:

- **Do not migrate existing endpoints unless the caller changes.** Every
  existing endpoint is consumed by frontend code that assumes its current shape;
  a global rewrite would break every list page at once.
- **Default new collection endpoints to the envelope shape** so they can grow
  pagination without a shape change.
- **When an existing endpoint actually needs pagination**, migrate it and audit
  the frontend callers at the same time.

## Envelope shape (preferred for new endpoints)

```json
{
  "items": [...],
  "total": 123,
  "limit": 50,
  "offset": 0
}
```

`items` is always the array (never null). `total` is the unfiltered count when
easy to compute, otherwise omitted. `limit` and `offset` echo the request so the
caller can wire pagination without re-parsing its own state.

## Current inventory

| Endpoint | Shape | Notes |
|---|---|---|
| `GET /api/jobs` | Raw array | Consumed by Schedule, PropertyDetail, ClientProfile — all assume array. Migration must land with a frontend audit. |
| `GET /api/quotes` | Raw array | Consumed by Quoting. |
| `GET /api/invoices` | Raw array | Consumed by Invoicing, ClientProfile. |
| `GET /api/clients` | Raw array | Consumed by ClientList, GlobalSearch. |
| `GET /api/properties` | Raw array | Consumed by PropertiesList, ClientProfile. |
| `GET /api/activities` | Raw array | Consumed by client timeline. |
| `GET /api/intake` | Raw array | Consumed by Requests. |
| `GET /api/opportunities` | Raw array | Consumed by Pipeline. |
| `GET /api/recurring` | Raw array | Consumed by Recurring page. |
| `GET /api/comms/client/{id}` | Object `{messages: [...]}` | Not a strict envelope but wraps the array — treat as envelope-shaped. |
| `GET /api/visits` | Envelope `{items, total, limit, offset}` | The one that already migrated. Caller must handle. |

## Callers must never assume shape

If you're consuming an endpoint from this list, unwrap defensively. `#89`'s
`toArray()` helper in the frontend is the pattern:

```js
const toArray = (r) => Array.isArray(r) ? r : (r?.items ?? [])
```

Use it at the boundary so the domain code downstream sees a plain array either
way. This keeps a future shape migration a one-line change at the fetch site
rather than a hunt through every filter/map/reduce.

## Adding a new collection endpoint

1. Return the envelope shape from day one.
2. Add a row to the table above.
3. In the caller, use `toArray()` so a future shape change is still a one-liner.
