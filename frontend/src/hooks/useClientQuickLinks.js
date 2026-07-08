import { useEffect, useState } from 'react'
import { get } from '../api'
import { todayYMD } from '../utils/format'

// "Needs a look" subsets, not the full collection — this is a compact
// sidebar summary, not ClientProfile's Money tab. Statuses match
// components/client/constants.js's QUOTE_COLORS/INVOICE_COLORS.
const OPEN_QUOTE_STATUSES = new Set(['sent', 'viewed', 'changes_requested'])
const UNPAID_INVOICE_STATUSES = new Set(['sent', 'overdue'])
const OPEN_JOB_STATUSES = new Set(['scheduled', 'in_progress'])

const EMPTY = { openQuotes: [], upcomingJobs: [], unpaidInvoices: [] }

/** Quick "what's open for this client" links for the Comms ContactPanel —
 *  the Twenty-style "linked both ways" piece: a thread's contact panel
 *  shouldn't be a dead end at just phone/email/address. Reuses the same
 *  /api/quotes, /api/jobs, /api/invoices endpoints ClientProfile already
 *  calls (via useClientProfileData) rather than adding a new backend
 *  aggregate — client-scoped result sets here are always small. */
export function useClientQuickLinks(clientId) {
  const [links, setLinks] = useState(EMPTY)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!clientId) { setLinks(EMPTY); return }
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
        // Codex review on #532: toISOString().slice(0, 10) uses UTC, which
        // has already rolled to tomorrow during US evening hours — that
        // silently dropped today's still-upcoming jobs. todayYMD() reads
        // the local calendar date instead (see its own doc comment for the
        // same footgun on the Schedule page).
        const today = todayYMD()
        setLinks({
          openQuotes: (quotes || [])
            .filter(q => OPEN_QUOTE_STATUSES.has(q.status))
            .slice(0, 3),
          upcomingJobs: (jobs || [])
            .filter(j => j.scheduled_date >= today && OPEN_JOB_STATUSES.has(j.status))
            .sort((a, b) => (a.scheduled_date || '').localeCompare(b.scheduled_date || ''))
            .slice(0, 3),
          unpaidInvoices: (invoices || [])
            .filter(i => UNPAID_INVOICE_STATUSES.has(i.status))
            .slice(0, 3),
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [clientId])

  return { ...links, loading }
}
