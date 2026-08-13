import { useCallback, useEffect, useState } from 'react'
import { get, getCached } from '../api'
import { today } from '../components/dashboard/utils'
import { toLocalYMD } from '../utils/format'

/** Data hook for the Dashboard command center.
 *
 *  Fires a Promise.allSettled fan-out across every backend the dashboard
 *  reads from (jobs today + this week, invoices, comms conversations,
 *  service revenue, comms summary, quote follow-ups, dispatch employees,
 *  and the server-computed KPI aggregate). Total-failure returns an
 *  `error` flag so the parent can render an ErrorState with a retry.
 *  Partial failures degrade the tile that owns them and leave the rest
 *  intact.
 *
 *  Every setter's fallback matches the shape the tiles expect — plain
 *  arrays for lists, {} for the summary maps — so a bad payload can't
 *  crash the render. `rosterUnavailable` distinguishes "no employees
 *  yet" from "roster fetch failed" so CrewWorkloadTile can show its
 *  diagnostic banner. The roster is native (/api/dispatch/employees
 *  reads cleaner users, not Connecteam). */
export function useDashboardData() {
  const [todayJobs, setTodayJobs] = useState([])
  const [weekJobs, setWeekJobs] = useState([])
  const [invoices, setInvoices] = useState([])
  const [followUps, setFollowUps] = useState([])
  const [todayVisits, setTodayVisits] = useState([])
  const [overdueConvs, setOverdueConvs] = useState([])
  const [unassignedConvs, setUnassignedConvs] = useState([])
  const [svcRevenue, setSvcRevenue] = useState([])
  const [commsSummary, setCommsSummary] = useState({})
  const [employees, setEmployees] = useState([])
  const [rosterUnavailable, setRosterUnavailable] = useState(false)
  // Server-computed KPI aggregates (quote funnel/pipeline, new leads,
  // active clients) from /api/dashboard/summary — replaces pulling full
  // quote/lead/client lists just to count them.
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  // Total-failure flag (backend down / everything timed out) → show a
  // retryable error instead of a silently-empty dashboard. Partial
  // failures still render.
  const [error, setError] = useState(false)

  const t = today()
  const weekEnd = toLocalYMD(new Date(Date.now() + 7 * 864e5))

  const reload = useCallback(async () => {
    setLoading(true)
    setError(false)
    // No per-call .catch here: allSettled lets us tell "one tile failed"
    // (degrade that tile) from "everything failed" (show the error screen).
    const results = await Promise.allSettled([
      get(`/api/jobs?date=${t}`),
      get(`/api/jobs?date_from=${t}&date_to=${weekEnd}`),
      get('/api/invoices?limit=200'),
      // Job/Visit unification (PR-B): today's occurrences read from /api/jobs.
      get(`/api/jobs?date=${t}`),
      get('/api/comms/conversations?sla_state=breached&status=open&limit=20'),
      get('/api/comms/conversations?assignee=unassigned&status=open&limit=20'),
      get('/api/invoices/summary/by-service?period=mtd'),
      getCached('/api/comms/conversations/summary'),
      get('/api/quotes/follow-ups'),
      get('/api/dispatch/employees'),
      // Aggregate KPI endpoint: quote funnel/pipeline, new-lead count and
      // active-client count, computed server-side with indexed SQL. Replaces
      // the old quotes(500) + intake(200) + clients(active) row-pulls.
      get('/api/dashboard/summary'),
    ])

    if (results.every(r => r.status === 'rejected')) {
      console.error('[Dashboard] load failed:', results[0]?.reason)
      setError(true)
      setLoading(false)
      return
    }

    const val = (i, d) => (results[i].status === 'fulfilled' ? results[i].value : d)
    const jobsToday = val(0, []), jobsWeek = val(1, []), invoicesAll = val(2, [])
    // /api/jobs returns a plain array; the old `{ items: [] }` shape came
    // from /api/visits and is no longer produced (fallback still tolerated).
    const visitsToday = val(3, [])
    const conversationsOverdue = val(4, { items: [] })
    const conversationsUnassigned = val(5, { items: [] })
    const svcRevenueResp = val(6, { by_service: [] })
    const commsSummaryResp = val(7, {})
    const followUpsResp = val(8, [])
    const employeesAll = results[9].status === 'fulfilled' ? results[9].value : null
    const summaryResp = val(10, null)

    setTodayJobs(Array.isArray(jobsToday) ? jobsToday : [])
    setWeekJobs(Array.isArray(jobsWeek) ? jobsWeek : [])
    setInvoices(Array.isArray(invoicesAll) ? invoicesAll : [])
    const tv = Array.isArray(visitsToday) ? visitsToday : (visitsToday?.items || [])
    setTodayVisits(tv)
    setOverdueConvs(Array.isArray(conversationsOverdue) ? conversationsOverdue : (conversationsOverdue?.items || []))
    setUnassignedConvs(Array.isArray(conversationsUnassigned) ? conversationsUnassigned : (conversationsUnassigned?.items || []))
    setSvcRevenue(Array.isArray(svcRevenueResp?.by_service) ? svcRevenueResp.by_service : [])
    setCommsSummary(commsSummaryResp && typeof commsSummaryResp === 'object' ? commsSummaryResp : {})
    setFollowUps(Array.isArray(followUpsResp) ? followUpsResp : (followUpsResp?.items || []))
    // null = roster fetch failed (Connecteam down / bad credentials). The
    // tile still renders workload from job data; names degrade to IDs.
    setRosterUnavailable(employeesAll === null)
    setEmployees(Array.isArray(employeesAll) ? employeesAll : (employeesAll?.items || []))
    setSummary(summaryResp && typeof summaryResp === 'object' ? summaryResp : null)
    setLoading(false)
  }, [t, weekEnd])

  useEffect(() => { reload() }, [reload])

  return {
    todayJobs, weekJobs, invoices, followUps, todayVisits,
    overdueConvs, unassignedConvs,
    svcRevenue, commsSummary,
    employees, rosterUnavailable,
    summary,
    loading, error,
    reload,
    t, weekEnd,
  }
}
