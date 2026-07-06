import { useEffect, useMemo, useState } from 'react'
import { get } from '../api'

/** Data hook for the Clients list.
 *
 *  Owns the fetched clients array, refetches whenever `statusFilter`
 *  changes, exposes a memoized `filtered` array (name/phone/email
 *  substring match) and a `statusCounts` map for the toolbar pills.
 *  Also exposes `setClients` so the parent can do optimistic
 *  inline-edit updates (e.g. `updateStatus`).
 *
 *  Split from Clients.jsx as part of the mega-page decomposition. */
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

  const load = () => Promise.all([
    get(`/api/clients${statusFilter ? `?status=${statusFilter}` : ''}`)
      .then(setClients)
      .catch(err => console.error('[Clients]', err)),
    loadCounts(),
  ])

  useEffect(() => { load() }, [statusFilter])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return clients.filter(c =>
      !search || (c.name || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(search) || (c.email || '').toLowerCase().includes(q)
    )
  }, [clients, search])

  return { clients, setClients, filtered, statusCounts, load }
}
