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
/** Past-dated and still in one of these = nobody closed it out.
 *
 *  The Job vocabulary is `unscheduled | scheduled | in_progress | completed |
 *  cancelled` (database/models.py). `cancelled` and `completed` are resolved;
 *  `unscheduled` has no meaningful date to be late against. What's left is a
 *  visit the calendar still believes in, on a day that has already passed. */
const UNRESOLVED_JOB_STATUSES = new Set(['scheduled', 'in_progress'])

/** Is this job a visit the calendar still believes in, on a day that's gone?
 *
 *  Exported, and used by `ContactPanel`'s "Recent visits" row as well as the
 *  note in the thread, because the two spelled the rule out separately and
 *  disagreed. `pastJobs` lumps in anything whose date sorts before today —
 *  and `(null || '') < today` is TRUE, so an `unscheduled` job from an
 *  accepted quote whose date nobody has picked yet landed there with no date
 *  at all. The panel then called it "not closed out" while the note correctly
 *  said nothing, which is the worst of both: a nag about work that was never
 *  promised for any particular day.
 *
 *  One predicate, one answer, in both places. */
export function isUnresolvedVisit(job, today) {
  const date = job?.scheduled_date || ''
  return Boolean(date) && date < today && UNRESOLVED_JOB_STATUSES.has(job?.status)
}

const EMPTY = {
  upcomingJobs: [],
  pastJobs: [],
  unresolvedVisits: [],
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
    // Clear FIRST, on every change of client — not just on no client.
    //
    // Three requests take a moment, and until they landed this hook kept
    // serving the PREVIOUS customer's jobs, quotes and money. On a panel that
    // is merely stale data; under the unresolved-visit note it is a false
    // statement about the person whose thread is open, with a link to someone
    // else's job. An empty panel for 200ms is the better wrong answer.
    setData(EMPTY)
    if (!clientId) return
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

        // Visits the calendar still believes in, on a day that has gone by.
        //
        // The data was always here — `pastJobs` lumps "completed" together
        // with "anything dated before today", so a visit nobody closed out
        // arrived as ordinary history and the signal was flattened away. A
        // customer writing "no one came yesterday" is reporting something the
        // app could already have told the operator.
        //
        // Read-only, deliberately: Job is canonical (scheduling-invariants
        // Rule 0), and the place to resolve one of these is the Schedule,
        // which owns that state. This derives a question, not an answer.
        const unresolvedVisits = jobList
          .filter(j => isUnresolvedVisit(j, today))
          .sort(byDateDesc)

        const paidInvoices = (invoices || []).filter(i => i.status === 'paid')
        const lifetimeValue = paidInvoices.reduce((sum, i) => sum + (Number(i.total) || 0), 0)
        const visitCount = jobList.filter(j => DONE_JOB_STATUSES.has(j.status)).length

        setData({
          upcomingJobs,
          pastJobs,
          unresolvedVisits,
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
