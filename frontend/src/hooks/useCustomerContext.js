import { useEffect, useState } from 'react'
import { get } from '../api'
import { todayYMD } from '../utils/format'

/**
 * Customer-360 context for the inbox — the "everything I need while I'm
 * texting them" aggregate that powers the redesigned ContactPanel. It's the
 * Twenty-CRM record-detail idea applied to a live conversation: one glance at
 * a customer's whole relationship without leaving the thread.
 *
 * Richer than useClientQuickLinks (which is a 3-item "needs a look" summary):
 * this returns the full upcoming schedule, recent visit history, open money,
 * and headline stats (visit count, lifetime paid, last/next service). Reuses
 * the same client-scoped /api/jobs|quotes|invoices endpoints — result sets are
 * always small per client, so no new backend aggregate is needed.
 */

const OPEN_QUOTE_STATUSES = new Set(['sent', 'viewed', 'changes_requested'])
const UNPAID_INVOICE_STATUSES = new Set(['sent', 'overdue'])
const UPCOMING_JOB_STATUSES = new Set(['scheduled', 'in_progress'])
const DONE_JOB_STATUSES = new Set(['completed'])

const EMPTY = {
  upcomingJobs: [],
  pastJobs: [],
  openQuotes: [],
  unpaidInvoices: [],
  stats: { visitCount: 0, lifetimeValue: 0, lastServiceDate: null, nextServiceDate: null },
}

const byDateAsc = (a, b) => (a.scheduled_date || '').localeCompare(b.scheduled_date || '')
const byDateDesc = (a, b) => (b.scheduled_date || '').localeCompare(a.scheduled_date || '')

export function useCustomerContext(clientId) {
  const [data, setData] = useState(EMPTY)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!clientId) { setData(EMPTY); return }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [quotes, jobs, invoices] = await Promise.all([
          get(`/api/quotes?client_id=${clientId}`).catch(() => []),
          get(`/api/jobs?client_id=${clientId}`).catch(() => []),
          get(`/api/invoices?client_id=${clientId}`).catch(() => []),
        ])
        if (cancelled) return
        const today = todayYMD()  // local calendar date (UTC would drop "today" in US evenings)
        const jobList = jobs || []

        const upcomingJobs = jobList
          .filter(j => (j.scheduled_date || '') >= today && UPCOMING_JOB_STATUSES.has(j.status))
          .sort(byDateAsc)
        const pastJobs = jobList
          .filter(j => DONE_JOB_STATUSES.has(j.status) || (j.scheduled_date || '') < today)
          .sort(byDateDesc)
          .slice(0, 5)

        const paidInvoices = (invoices || []).filter(i => i.status === 'paid')
        const lifetimeValue = paidInvoices.reduce((sum, i) => sum + (Number(i.total) || 0), 0)
        const visitCount = jobList.filter(j => DONE_JOB_STATUSES.has(j.status)).length

        setData({
          upcomingJobs,
          pastJobs,
          openQuotes: (quotes || []).filter(q => OPEN_QUOTE_STATUSES.has(q.status)).slice(0, 5),
          unpaidInvoices: (invoices || []).filter(i => UNPAID_INVOICE_STATUSES.has(i.status)).slice(0, 5),
          stats: {
            visitCount,
            lifetimeValue,
            lastServiceDate: pastJobs[0]?.scheduled_date || null,
            nextServiceDate: upcomingJobs[0]?.scheduled_date || null,
          },
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [clientId])

  return { ...data, loading }
}
