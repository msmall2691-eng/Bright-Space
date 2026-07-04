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

  const load = () =>
    get(`/api/clients${statusFilter ? `?status=${statusFilter}` : ''}`)
      .then(setClients)
      .catch(err => console.error('[Clients]', err))

  useEffect(() => { load() }, [statusFilter])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return clients.filter(c =>
      !search || (c.name || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(search) || (c.email || '').toLowerCase().includes(q)
    )
  }, [clients, search])

  // One pass over clients (was four .filter() scans), recomputed only when the
  // client list changes rather than on every render.
  const statusCounts = useMemo(() => {
    const counts = { '': clients.length, lead: 0, active: 0, inactive: 0 }
    for (const c of clients) {
      if (c.status in counts) counts[c.status] += 1
    }
    return counts
  }, [clients])

  return { clients, setClients, filtered, statusCounts, load }
}
