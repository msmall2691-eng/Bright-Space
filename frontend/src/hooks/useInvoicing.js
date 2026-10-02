import { useCallback, useEffect, useMemo, useState } from 'react'
import { get } from '../api'

/** Data hook for the Invoicing list page.
 *
 *  Owns the fetched invoices + clients arrays, refetches invoices
 *  whenever `statusFilter` changes, exposes a memoized `filtered`
 *  array (client-name or invoice-number substring match) and the
 *  three headline totals the metrics bar shows: paid revenue,
 *  outstanding, overdue count. Exposes `setInvoices` so the mutation
 *  hook can patch a row optimistically (mark paid / overdue) and
 *  reconcile with a background refetch. `clientName` / `clientOf`
 *  helpers stay here since they key off the clients cache. */
export function useInvoicing({ statusFilter, search }) {
  const [invoices, setInvoices] = useState([])
  const [clients, setClients]   = useState([])
  // First-paint only: shows the shaped skeleton until the initial fetch lands so
  // a cold backend reads as "loading", not "no invoices yet". Left false on the
  // background reconcile loads (mark paid / overdue) so the list never flickers.
  const [loading, setLoading]   = useState(true)
  // Accurate money headline across ALL invoices (GET /api/invoices/summary),
  // independent of the list's page (default 50) and status filter — so the KPI
  // tiles + AR aging don't summarize only the visible page. One fetch for the
  // headline need; the list fetch below stays the paginated table (economy).
  const [summary, setSummary]   = useState(null)

  const load = useCallback(() =>
    Promise.all([
      get(`/api/invoices${statusFilter ? `?status=${statusFilter}` : ''}`).then(setInvoices),
      get('/api/invoices/summary').then(setSummary),
    ])
      .catch(err => console.error('[Invoicing]', err))
      .finally(() => setLoading(false)),
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
  const overdueTotal = useMemo(() =>
    invoices.filter(i => i.status === 'overdue').reduce((s, i) => s + (i.total || 0), 0),
    [invoices])

  // Page-derived aging — used only as a fallback for the brief moment before the
  // summary fetch lands. Buckets: not-yet-due (or no due date), 1–30, 31–60, 60+.
  const aging = useMemo(() => {
    const b = { current: 0, d1_30: 0, d31_60: 0, d60_plus: 0 }
    for (const i of invoices) {
      if (!['sent', 'overdue'].includes(i.status)) continue
      const amt = i.total || 0
      const d = i.due_date ? Math.floor((Date.now() - new Date(i.due_date)) / 86400000) : 0
      if (d <= 0) b.current += amt
      else if (d <= 30) b.d1_30 += amt
      else if (d <= 60) b.d31_60 += amt
      else b.d60_plus += amt
    }
    return b
  }, [invoices])

  // Prefer the accurate all-invoices summary; fall back to the page-derived
  // figures until it lands (and if the endpoint ever errors).
  return {
    invoices, setInvoices,
    clients, loading,
    clientName, clientOf,
    filtered,
    totalRevenue: summary ? summary.collected : totalRevenue,
    outstanding: summary ? summary.outstanding : outstanding,
    overdueCount: summary ? summary.overdue_count : overdueCount,
    overdueTotal: summary ? summary.overdue_total : overdueTotal,
    aging: summary ? summary.aging : aging,
    load,
  }
}
