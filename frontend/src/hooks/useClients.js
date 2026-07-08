import { useEffect, useMemo, useState } from 'react'
import { get } from '../api'

/** Data hook for the Clients list.
 *
 *  Owns the fetched clients array, refetches whenever `statusFilter` or
 *  the debounced `search` changes, exposes `filtered` (identity, since
 *  the server already applied the search) and a `statusCounts` map for
 *  the toolbar pills. `setClients` still supports optimistic inline
 *  edits (e.g. `updateStatus`) from the parent.
 *
 *  T-06: the audit found the page fetched with the default 50-row cap
 *  and the search was client-side over that same 50 — so any client
 *  past position 50 was invisible AND unsearchable (Paul Day was
 *  missing from a workspace of 107). Now the fetch pulls up to 1000
 *  rows (covers the current book with room to grow) AND forwards
 *  `search` to the server so even in a bigger workspace typing a name
 *  finds the record. If the workspace ever pushes past 1000 clients
 *  we'll need proper pagination here, but that's a very different
 *  scale problem than the "50 of 107" bug this closes.
 *
 *  Split from Clients.jsx as part of the mega-page decomposition. */
const LOOKUP_LIMIT = 1000

export function useClients(statusFilter, search) {
  const [clients, setClients] = useState([])
  // Whole-DB tab counts, sourced from /api/clients/counts. Kept separate from
  // `clients` because that array is scoped to the currently-selected tab —
  // deriving counts from it made non-current tabs read as 0 whenever a status
  // filter was active (audit bug: creating a client left "All" frozen).
  const [statusCounts, setStatusCounts] = useState({ '': 0, lead: 0, active: 0, inactive: 0 })

  const loadCounts = () =>
    get('/api/clients/counts')
      .then((c) => setStatusCounts({ '': 0, lead: 0, active: 0, inactive: 0, ...c }))
      .catch(err => console.error('[Clients counts]', err))

  const _buildUrl = (q) => {
    const params = new URLSearchParams({ limit: String(LOOKUP_LIMIT) })
    if (statusFilter) params.append('status', statusFilter)
    if (q && q.trim()) params.append('search', q.trim())
    return `/api/clients?${params.toString()}`
  }

  const load = (q = search) => Promise.all([
    get(_buildUrl(q))
      .then(setClients)
      .catch(err => console.error('[Clients]', err)),
    loadCounts(),
  ])

  // Debounce search-driven refetches so every keystroke doesn't hit the
  // server; status changes fire immediately (deps still include search
  // but the timer collapses bursts). The 250ms window matches
  // JobCreateModal's typeahead.
  useEffect(() => {
    const t = setTimeout(() => { load(search) }, search ? 250 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, search])

  // Server already matched — no client-side filter needed. Kept as
  // identity so downstream callers reading `filtered` don't break.
  const filtered = useMemo(() => clients, [clients])

  return { clients, setClients, filtered, statusCounts, load }
}
