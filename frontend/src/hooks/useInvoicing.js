import { useCallback, useEffect, useMemo, useState } from 'react'
import { get } from '../api'

/** Data hook for the Invoicing list page.
 *
 *  Owns the fetched invoices + clients arrays, refetches invoices
 *  whenever `statusFilter` changes, exposes a memoized `filtered`
 *  array (client-name or invoice-number substring match) and the
 *  three headline totals the metrics bar shows: paid revenue,
 *  outstanding, overdue count. Exposes `setInvoices` too — kept for
 *  parity, though mutations always refetch instead of patching in
 *  place. `clientName` / `clientOf` helpers stay here since they
 *  key off the clients cache. */
export function useInvoicing({ statusFilter, search }) {
  const [invoices, setInvoices] = useState([])
  const [clients, setClients]   = useState([])

  const load = useCallback(() =>
    get(`/api/invoices${statusFilter ? `?status=${statusFilter}` : ''}`)
      .then(setInvoices)
      .catch(err => console.error('[Invoicing]', err)),
    [statusFilter]
  )

  useEffect(() => { load() }, [load])
  useEffect(() => {
    // T-06: preload up to 1000 so `clientName(id)` resolves for every
    // client (was defaulting to 50 and showing "Client #99" on invoices
    // for clients past position 50).
    get('/api/clients?limit=1000').then(setClients).catch(err => console.error('[Invoicing]', err))
  }, [])

  const clientName = (id) => clients.find(c => c.id === id)?.name || `Client #${id}`
  const clientOf   = (id) => clients.find(c => c.id === id)

  const filtered = useMemo(() => {
    if (!search) return invoices
    const q = search.toLowerCase()
    return invoices.filter(inv =>
      clientName(inv.client_id).toLowerCase().includes(q) ||
      inv.invoice_number.toLowerCase().includes(q)
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, search, clients])

  const totalRevenue = useMemo(() =>
    invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total || 0), 0),
    [invoices])
  const outstanding = useMemo(() =>
    invoices.filter(i => ['sent', 'overdue'].includes(i.status)).reduce((s, i) => s + (i.total || 0), 0),
    [invoices])
  const overdueCount = useMemo(() =>
    invoices.filter(i => i.status === 'overdue').length,
    [invoices])

  return {
    invoices, setInvoices,
    clients,
    clientName, clientOf,
    filtered,
    totalRevenue, outstanding, overdueCount,
    load,
  }
}
