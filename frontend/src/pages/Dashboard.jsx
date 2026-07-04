/**
 * Dashboard — Command Center.
 *
 * Three focused tiles, each linking to its dedicated page:
 *   1. INBOX     — what needs attention right now (overdue / unassigned /
 *                  late visits / past-due invoices, deduped)
 *   2. TODAY     — today's schedule preview
 *   3. MONEY     — revenue + AR + pipeline at a glance
 *
 * Replaces the prior 4-KPI + 3-column layout. The MiniCalendar widget was
 * removed because it duplicated /schedule's month view; the "Today's
 * priorities" + "Unified inbox" split was collapsed into a single de-duped
 * inbox tile so the same conversation can't appear in three sections.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, getCached } from '../api'
import { htmlToText } from '../utils/format'
import { StatCard, EmptyState, ErrorState } from '../components/ui'
import { AIFollowUps } from '../components/AIFollowUps'
import {
  Calendar, DollarSign,
  CheckCircle2, Clock, ArrowRight, Zap, FileText, Users, TrendingUp,
} from 'lucide-react'
import { today, monthStart, fmtMoney, contactLabel, channelIcon } from '../components/dashboard/utils'
import { Tile, KpiCard, TileLoading } from '../components/dashboard/primitives'
import { Funnel } from '../components/dashboard/Funnel'
import { InboxTile } from '../components/dashboard/InboxTile'
import { TodayTile } from '../components/dashboard/TodayTile'

/* ── Page ─────────────────────────────────────────────────────────── */
export default function Dashboard() {
  const navigate = useNavigate()
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
  // Server-computed KPI aggregates (quote funnel/pipeline, new leads, active
  // clients) from /api/dashboard/summary — replaces pulling full quote/lead/
  // client lists just to count them.
  const [summary, setSummary] = useState(null)
  const activeClients = summary?.active_clients ?? null
  const [loading, setLoading] = useState(true)
  // Total-failure flag (backend down / everything timed out) → show a retryable
  // error instead of a silently-empty dashboard. Partial failures still render.
  const [error, setError] = useState(false)

  const t = today()
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

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

  /* ── Money calcs ── */
  const todayRevenue = useMemo(() => invoices
    .filter(i => i.status === 'paid' && (i.paid_at || '').slice(0, 10) === t)
    .reduce((s, i) => s + (i.total || 0), 0), [invoices, t])
  const mtdRevenue = useMemo(() => invoices
    .filter(i => i.status === 'paid' && (i.paid_at || '').slice(0, 10) >= monthStart())
    .reduce((s, i) => s + (i.total || 0), 0), [invoices])
  const outstanding = useMemo(() => invoices
    .filter(i => ['sent', 'overdue'].includes(i.status))
    .reduce((s, i) => s + (i.total || 0), 0), [invoices])
  const pipeline = summary?.quotes?.pipeline_value ?? 0
  const overdueInvoiceCount = invoices.filter(i => i.status === 'overdue').length

  // Quotes & leads that need the owner to do something next — from the server
  // aggregate (counts only; the dashboard never needed the full quote rows).
  const quoteActions = useMemo(() => ({
    awaiting: summary?.quotes?.awaiting ?? 0,
    changes: summary?.quotes?.changes ?? 0,
    toSchedule: summary?.quotes?.to_schedule ?? 0,
    newLeads: summary?.new_leads ?? 0,
    followUp: followUps.length,
  }), [summary, followUps])

  // Lead → client funnel: the conversion pipeline as four ordered stages.
  // "Quoted" = quotes out for response (sent/viewed/changes); "Won" = quotes
  // that became jobs. convRate = won ÷ everyone who entered the funnel.
  const funnel = useMemo(() => {
    const quoted = summary?.quotes?.quoted ?? 0
    const accepted = summary?.quotes?.accepted ?? 0
    const won = summary?.quotes?.won ?? 0
    const newLeads = quoteActions.newLeads
    const entered = newLeads + quoted + accepted + won
    const stages = [
      { key: 'new', label: 'New leads', n: newLeads, tone: { text: 'text-purple-600', bar: 'bg-purple-500' },
        sub: 'to quote', onClick: () => navigate('/billing?view=quotes&tab=leads') },
      { key: 'quoted', label: 'Quoted', n: quoted, tone: { text: 'text-blue-600', bar: 'bg-blue-500' },
        sub: 'awaiting reply', onClick: () => navigate('/billing?view=quotes&tab=quotes') },
      { key: 'accepted', label: 'Accepted', n: accepted, tone: { text: 'text-amber-600', bar: 'bg-amber-500' },
        sub: 'ready to schedule', onClick: () => navigate('/billing?view=quotes&tab=quotes') },
      { key: 'won', label: 'Won', n: won, tone: { text: 'text-emerald-600', bar: 'bg-emerald-500' },
        sub: 'became jobs', onClick: () => navigate('/clients') },
    ]
    const convRate = entered > 0 ? Math.round((won / entered) * 100) : 0
    return { stages, convRate }
  }, [summary, quoteActions.newLeads, navigate])

  // STR turnover coverage for the next 7 calendar days (today + 6; weekJobs is
  // fetched with an inclusive +7 end, so clamp here). "Covered" = a cleaner is
  // assigned.
  const turnover = useMemo(() => {
    const sixOut = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10)
    const str = weekJobs.filter(j =>
      j.job_type === 'str_turnover' && j.status !== 'cancelled' &&
      (j.scheduled_date || '').slice(0, 10) <= sixOut)
    const needCrew = str.filter(j => !(j.cleaner_ids && j.cleaner_ids.length > 0))
    return { total: str.length, needCrew: needCrew.length }
  }, [weekJobs])

  // Uncapped breached count from the summary endpoint (the list is limit=20).
  const slaBreached = commsSummary.breached ?? overdueConvs.length

  // Crew workload for the next 7 days: jobs assigned per cleaner + unassigned.
  const crew = useMemo(() => {
    const sixOut = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10)
    const jobs = weekJobs.filter(j => j.status !== 'cancelled' && (j.scheduled_date || '').slice(0, 10) <= sixOut)
    const nameOf = (id) => employees.find(e => String(e.id) === String(id))?.name || `Cleaner ${id}`
    const counts = {}
    let unassigned = 0
    for (const j of jobs) {
      const ids = j.cleaner_ids || []
      if (ids.length === 0) { unassigned++; continue }
      for (const id of ids) counts[id] = (counts[id] || 0) + 1
    }
    const rows = Object.entries(counts)
      .map(([id, n]) => ({ id, name: nameOf(id), n }))
      .sort((a, b) => b.n - a.n)
    return { rows, unassigned, total: jobs.length }
  }, [weekJobs, employees])

  // AR aging buckets — so the operator knows WHO to call this morning.
  // Groups overdue invoices by age: 0-30, 30-60, 60-90, 90+ days.
  const arAging = useMemo(() => {
    const now = Date.now()
    const buckets = { current: [], '30': [], '60': [], '90': [] }
    invoices
      .filter(i => ['sent', 'overdue'].includes(i.status))
      .forEach(i => {
        const due = i.due_date ? new Date(i.due_date).getTime() : null
        if (!due) { buckets.current.push(i); return }
        const daysOverdue = Math.max(0, Math.floor((now - due) / 86400000))
        if (daysOverdue >= 90) buckets['90'].push(i)
        else if (daysOverdue >= 60) buckets['60'].push(i)
        else if (daysOverdue >= 30) buckets['30'].push(i)
        else buckets.current.push(i)
      })
    return buckets
  }, [invoices])

  /* ── Unified attention list. Each category is capped before pushing
        so a flood of overdue replies can't crowd out late visits or
        past-due invoices. Deduped on conversation id so the same
        thread can't appear as both overdue AND unassigned. ── */
  const attention = useMemo(() => {
    const items = []
    const seenConvs = new Set()
    const nowHHMM = new Date().toTimeString().slice(0, 5)

    overdueConvs.slice(0, 3).forEach(c => {
      if (seenConvs.has(c.id)) return
      seenConvs.add(c.id)
      items.push({
        key: `od-${c.id}`,
        tone: 'red',
        title: `Overdue reply · ${contactLabel(c)}`,
        sub: htmlToText(c.preview) || 'Awaiting reply',
        action: 'Reply',
        onClick: () => navigate('/comms'),
      })
    })

    todayVisits
      .filter(v => v.status === 'scheduled' && (v.start_time || '').slice(0, 5) < nowHHMM)
      .slice(0, 3)
      .forEach(v => items.push({
        key: `late-${v.id}`,
        tone: 'amber',
        title: `Late start · ${v.title || `Job #${v.id}`}`,
        sub: `${(v.start_time || '').slice(0, 5)} · ${v.property_name || ''}`,
        action: 'Open',
        onClick: () => navigate('/schedule'),
      }))

    unassignedConvs.slice(0, 2).forEach(c => {
      if (seenConvs.has(c.id)) return
      seenConvs.add(c.id)
      items.push({
        key: `un-${c.id}`,
        tone: 'amber',
        title: `Unassigned · ${contactLabel(c)}`,
        sub: htmlToText(c.preview) || '',
        action: 'Assign',
        onClick: () => navigate('/comms'),
      })
    })

    invoices
      .filter(i => i.status === 'overdue')
      .slice(0, 2)
      .forEach(i => items.push({
        key: `inv-${i.id}`,
        tone: 'rose',
        title: `Past-due invoice · ${fmtMoney(i.total)}`,
        sub: `Invoice #${i.id}${i.client_name ? ` · ${i.client_name}` : ''}`,
        action: 'Call',
        onClick: () => navigate(`/invoices/${i.id}`),
      }))

    return items
  }, [overdueConvs, todayVisits, unassignedConvs, invoices, navigate])

  // Hidden-overflow counts so the CTA can route correctly when the
  // hidden item is a late visit or overdue invoice (which /comms can't
  // surface), not a conversation.
  const hiddenOverdueConvs = Math.max(0, overdueConvs.length - 3)
  const hiddenUnassignedConvs = Math.max(0, unassignedConvs.length - 2)
  const hiddenInvoices = Math.max(0, invoices.filter(i => i.status === 'overdue').length - 2)
  const hiddenLateVisits = Math.max(
    0,
    todayVisits.filter(v => v.status === 'scheduled').length - 3,
  )

  const todayCount = todayJobs.length
  const weekCount = weekJobs.length

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const longDate = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const paidCount = invoices.filter(i => i.status === 'paid').length
  const unpaidCount = invoices.filter(i => ['sent', 'overdue'].includes(i.status)).length

  if (error && !loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <ErrorState
          title="Couldn't load your dashboard"
          description="The server didn't respond. Check your connection and try again."
          onRetry={reload}
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg">
      {/* Greeting */}
      <div className="px-4 sm:px-6 pt-6 pb-3">
        <h1 className="text-2xl sm:text-[28px] font-bold text-ink tracking-tight">{greeting} 👋</h1>
        <p className="text-sm text-ink-3 mt-1">
          {longDate}
          {' · '}
          {todayCount === 0 ? 'no jobs today' : `${todayCount} job${todayCount > 1 ? 's' : ''} today`}
          {` · ${weekCount} this week`}
          {attention.length > 0 && ` · ${attention.length} need attention`}
        </p>
      </div>

      {/* KPI row — headline numbers, dashboard-style */}
      <div className="px-4 sm:px-6 grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard icon={DollarSign} chip="bg-emerald-50 text-emerald-600" label="Collected today"
          value={fmtMoney(todayRevenue)} sub={todayRevenue > 0 ? 'paid today' : 'nothing yet today'} />
        <KpiCard icon={TrendingUp} chip="bg-blue-50 text-blue-600" label="Month to date"
          value={fmtMoney(mtdRevenue)} sub={`${paidCount} paid`} />
        <KpiCard icon={Clock} chip="bg-amber-50 text-amber-600" label="Outstanding"
          value={fmtMoney(outstanding)}
          sub={`${unpaidCount} unpaid${overdueInvoiceCount ? ` · ${overdueInvoiceCount} overdue` : ''}`}
          accent={overdueInvoiceCount > 0 ? 'text-amber-600' : undefined} />
        <KpiCard icon={FileText} chip="bg-violet-50 text-violet-600" label="Pipeline"
          value={fmtMoney(pipeline)} sub={`${summary?.quotes?.sent ?? 0} sent`}
          accent="text-violet-700" />
      </div>

      {/* Lead → client funnel — the conversion pipeline at a glance */}
      <div className="px-4 sm:px-6 pt-4">
        <Funnel stages={funnel.stages} convRate={funnel.convRate} activeClients={activeClients} />
      </div>

      {/* Tiles grid */}
      <div className="px-4 sm:px-6 pt-4 pb-8 grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">

        <InboxTile
          loading={loading}
          attention={attention}
          slaBreached={slaBreached}
          hiddenOverdueConvs={hiddenOverdueConvs}
          hiddenUnassignedConvs={hiddenUnassignedConvs}
          hiddenLateVisits={hiddenLateVisits}
          hiddenInvoices={hiddenInvoices}
          navigate={navigate}
        />

        <TodayTile
          loading={loading}
          todayJobs={todayJobs}
          todayCount={todayCount}
          weekCount={weekCount}
          navigate={navigate}
        />

        {/* QUOTES & LEADS — what's in the funnel needing action */}
        <Tile
          icon={FileText}
          iconColor="text-purple-500"
          title="Quotes & leads"
          badge={(quoteActions.changes + quoteActions.newLeads) > 0 && (
            <span className="text-[10px] font-bold text-white bg-amber-500 px-1.5 py-0.5 rounded-full">
              {quoteActions.changes + quoteActions.newLeads}
            </span>
          )}
          action="Open Quoting"
          onAction={() => navigate('/billing?view=quotes&tab=quotes')}
        >
          {loading ? (
            <TileLoading />
          ) : (quoteActions.awaiting + quoteActions.changes + quoteActions.toSchedule + quoteActions.newLeads + quoteActions.followUp) === 0 ? (
            <EmptyState compact icon={CheckCircle2} title="Funnel clear"
              description="No quotes or leads waiting on you." />
          ) : (
            <div className="flex-1 space-y-1.5">
              {[
                { n: quoteActions.followUp, label: 'Need a follow-up nudge', tone: 'text-amber-700 bg-amber-50 border-amber-200', go: () => navigate('/billing?view=quotes&tab=follow-ups') },
                { n: quoteActions.changes, label: 'Changes requested', tone: 'text-amber-700 bg-amber-50 border-amber-200', go: () => navigate('/billing?view=quotes&tab=quotes') },
                { n: quoteActions.awaiting, label: 'Awaiting customer response', tone: 'text-blue-700 bg-blue-50 border-blue-200', go: () => navigate('/billing?view=quotes&tab=quotes') },
                { n: quoteActions.toSchedule, label: 'Accepted — ready to schedule', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200', go: () => navigate('/billing?view=quotes&tab=quotes') },
                { n: quoteActions.newLeads, label: 'New leads to quote', tone: 'text-purple-700 bg-purple-50 border-purple-200', go: () => navigate('/billing?view=quotes&tab=leads') },
              ].filter(r => r.n > 0).map((r, i) => (
                <button key={i} onClick={r.go}
                  className={`w-full flex items-center justify-between gap-2 border rounded-lg px-3 py-2 text-sm hover:opacity-90 transition-opacity ${r.tone}`}>
                  <span className="truncate">{r.label}</span>
                  <span className="font-bold shrink-0 flex items-center gap-1">{r.n} <ArrowRight className="w-3.5 h-3.5" /></span>
                </button>
              ))}
            </div>
          )}
        </Tile>

        {/* TURNOVER COVERAGE — STR cleanings this week and which need a crew */}
        <Tile
          icon={Zap}
          iconColor="text-amber-500"
          title="Turnover coverage"
          badge={turnover.needCrew > 0 && (
            <span className="text-[10px] font-bold text-white bg-amber-500 px-1.5 py-0.5 rounded-full">
              {turnover.needCrew} need a crew
            </span>
          )}
          action="Open schedule"
          onAction={() => navigate('/schedule')}
        >
          {loading ? (
            <TileLoading />
          ) : turnover.total === 0 ? (
            <EmptyState compact icon={CheckCircle2} title="No turnovers this week"
              description="STR cleanings will show here." />
          ) : (
            <div className="flex-1 grid grid-cols-2 gap-3">
              <StatCard label="Turnovers (7 days)" value={turnover.total} />
              <StatCard label="Need a cleaner"
                value={turnover.needCrew}
                accent={turnover.needCrew > 0 ? 'text-amber-600' : 'text-emerald-600'}
                onClick={() => navigate('/schedule')} />
            </div>
          )}
        </Tile>

        {/* CREW WORKLOAD — who's booked this week, to balance assignments */}
        <Tile
          icon={Users}
          iconColor="text-blue-500"
          title="Crew workload (7 days)"
          badge={crew.unassigned > 0 && (
            <span className="text-[10px] font-bold text-white bg-amber-500 px-1.5 py-0.5 rounded-full">
              {crew.unassigned} unassigned
            </span>
          )}
          action="Open schedule"
          onAction={() => navigate('/schedule')}
        >
          {loading ? (
            <TileLoading />
          ) : crew.rows.length === 0 && crew.unassigned === 0 ? (
            <EmptyState compact icon={Users} title="No jobs this week"
              description="Assignments will show here." />
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[300px] space-y-1.5">
              {rosterUnavailable && (
                <p className="text-[11px] text-ink-3 bg-bg-2 rounded-lg px-2.5 py-1.5">
                  Crew roster unavailable (Connecteam offline) — cleaners shown by ID.
                </p>
              )}
              {crew.rows.map(r => {
                const pct = crew.rows[0] ? Math.round((r.n / crew.rows[0].n) * 100) : 0
                return (
                  <div key={r.id} className="flex items-center gap-2 text-sm">
                    <span className="w-28 truncate text-ink-2 shrink-0">{r.name}</span>
                    <div className="flex-1 bg-bg-2 rounded-full h-2 overflow-hidden">
                      <div className="bg-blue-500 h-full rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-6 text-right font-semibold text-ink shrink-0">{r.n}</span>
                  </div>
                )
              })}
              {crew.unassigned > 0 && (
                <button onClick={() => navigate('/schedule')}
                  className="w-full flex items-center justify-between gap-2 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2 text-sm text-amber-800 hover:opacity-90 transition-opacity mt-1">
                  <span>Jobs with no crew assigned</span>
                  <span className="font-bold flex items-center gap-1">{crew.unassigned} <ArrowRight className="w-3.5 h-3.5" /></span>
                </button>
              )}
            </div>
          )}
        </Tile>

        {/* MONEY — full width on desktop */}
        <div className="lg:col-span-2">
        <Tile
          icon={DollarSign}
          iconColor="text-emerald-500"
          title="Money"
          action="Open Invoicing"
          onAction={() => navigate('/billing?view=invoices')}
        >
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-bg-2">
            <StatCard
              className="bg-panel"
              label="Today"
              value={fmtMoney(todayRevenue)}
              sub={todayRevenue > 0 ? 'collected today' : 'nothing collected yet'}
            />
            <StatCard
              className="bg-panel"
              label="Month to date"
              value={fmtMoney(mtdRevenue)}
              sub={`${invoices.filter(i => i.status === 'paid').length} paid`}
            />
            <StatCard
              className="bg-panel"
              label="Outstanding"
              value={fmtMoney(outstanding)}
              sub={`${invoices.filter(i => ['sent','overdue'].includes(i.status)).length} unpaid${overdueInvoiceCount > 0 ? ` · ${overdueInvoiceCount} overdue` : ''}`}
              accent={overdueInvoiceCount > 0 ? 'text-amber-600' : 'text-ink'}
              onClick={() => navigate('/billing?view=invoices')}
            />
            <StatCard
              className="bg-panel"
              label="Pipeline"
              value={fmtMoney(pipeline)}
              sub={`${summary?.quotes?.sent ?? 0} sent · ${summary?.quotes?.draft ?? 0} draft`}
              accent="text-emerald-600"
              onClick={() => navigate('/billing?view=quotes')}
            />
          </div>

          {/* AR Aging — who to call this morning */}
          {(arAging['30'].length + arAging['60'].length + arAging['90'].length) > 0 && (
            <div className="border-t border-hairline px-5 py-3">
              <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2">Aging receivables</div>
              <div className="flex gap-3 text-[12px]">
                {arAging['30'].length > 0 && (
                  <button onClick={() => navigate('/billing?view=invoices')} className="flex items-baseline gap-1 hover:text-amber-700 transition-colors">
                    <span className="text-amber-600 font-bold">{fmtMoney(arAging['30'].reduce((s, i) => s + (i.total || 0), 0))}</span>
                    <span className="text-ink-3">30-60d</span>
                  </button>
                )}
                {arAging['60'].length > 0 && (
                  <button onClick={() => navigate('/billing?view=invoices')} className="flex items-baseline gap-1 hover:text-orange-700 transition-colors">
                    <span className="text-orange-600 font-bold">{fmtMoney(arAging['60'].reduce((s, i) => s + (i.total || 0), 0))}</span>
                    <span className="text-ink-3">60-90d</span>
                  </button>
                )}
                {arAging['90'].length > 0 && (
                  <button onClick={() => navigate('/billing?view=invoices')} className="flex items-baseline gap-1 hover:text-red-700 transition-colors">
                    <span className="text-red-600 font-bold">{fmtMoney(arAging['90'].reduce((s, i) => s + (i.total || 0), 0))}</span>
                    <span className="text-ink-3">90d+</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Revenue by service type (paid, month-to-date) */}
          {svcRevenue.length > 0 && (
            <div className="border-t border-hairline px-5 py-3">
              <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2">Paid this month by service</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                {svcRevenue.map(s => (
                  <div key={s.service} className="flex items-baseline gap-1">
                    <span className="text-ink font-bold">{fmtMoney(s.total)}</span>
                    <span className="text-ink-3 capitalize">{(s.service || '').replace('str_turnover', 'STR').replace('_', ' ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Tile>
        </div>

        {/* AI-computed operational follow-ups — auto-loads, hides when all clear */}
        <AIFollowUps title="Operations check" className="lg:col-span-2" />

      </div>
    </div>
  )
}
