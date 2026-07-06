import { useCallback, useEffect, useState } from 'react'
import { get } from '../api'

/** Data hook for the Properties page.
 *
 *  Owns the two fetched collections (properties, active clients) and the
 *  `load` callback that re-fetches properties. Fires the initial fetch on
 *  mount for both.
 *
 *  `setClients` is exposed so the inline "+ New client" flow in
 *  PropertyForm can prepend the created client to the list without a
 *  round-trip to Clients. Mutation actions (save / addIcal / removeIcal /
 *  syncOne / bulkDelete / etc.) still live in Properties.jsx and call
 *  `load()` after their side effects, matching the pattern from other
 *  pages in this codebase. */
export function useProperties() {
  const [properties, setProperties] = useState([])
  const [clients, setClients] = useState([])

  const load = useCallback(() =>
    get('/api/properties').then(setProperties).catch(err => console.error('[Properties]', err)),
  [])

  useEffect(() => {
    load()
    // No status filter: a property can (and does) belong to a Lead-status
    // client. Filtering to active-only was wiping out the Client field in
    // Edit Property for every lead-linked property — Save would then unlink
    // the property from a real client.
    get('/api/clients?limit=1000').then(setClients).catch(err => console.error('[Properties]', err))
  }, [load])

  return { properties, clients, setClients, load }
}
