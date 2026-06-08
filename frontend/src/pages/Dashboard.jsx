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
import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { get } from '../api'
import { displayContactName, formatPhone } from '../utils/display'
import { Card, StatCard, EmptyState, Skeleton } from '../components/ui'
import { AIFollowUps } from '../components/AIBriefing'
import {
  Calendar, Inbox, DollarSign, Phone, Mail, MessageSquare,
  CheckCircle2, Clock, ArrowRight, Zap, FileText, Users,
} from 'lucide-react'

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => {
  const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}
const fmtMoney = (n) => `$${Math.round(n || 0).toLocaleString()}`

// Same fallback chain as displayContactName but prefers a friendlier
// "(617) 849-2813" over "Lead +16178492813" when the contact is just a phone.
function contactLabel(conv) {
  const named = displayContactName(conv?.client || {})
  if (named && !named.toLowerCase().startsWith('lead ')) return named
  if (conv?.external_contact && /\+?\d/.test(conv.external_contact)) return formatPhone(conv.external_contact)
  return named || 'Unknown'
}

const channelIcon = (ch) => ({ sms: Phone, email: Mail, chat: MessageSquare }[ch] || MessageSquare)


/* ── Attention row — unified across overdue / unassigned / late / overdue invoice ─ */
function AttentionRow({ tone, title, sub, action, onClick }) {
  const dotClass = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
  }[tone] || 'bg-ink-3'
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-bg active:bg-bg-2 transition-colors border-b border-hairline last:border-b-0"
    >
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-ink truncate">{title}</div>
        {sub && <div className="text-[11px] text-ink-3 mt-0.5 truncate">{sub}</div>}
      </div>
      {action && (
        <span className="text-[11px] font-semibold text-blue-600 shrink-0 mt-1.5">{action}</span>
      )}
    </button>
  )
}


/* ── Tile shell — the dashboard's calling convention over the shared Card
      primitive. Card owns the surface (bg-panel / border / radius), header
      row, icon, title + badge slot. Tile keeps the text+arrow "action" link
      so the three call sites below stay unchanged. Body is unpadded — each
      tile's children manage their own spacing (full-bleed lists, the money
      grid). ── */
function Tile({ icon, iconColor, title, badge, action, onAction, children }) {
  return (
    <Card
      as="section"
      icon={icon}
      iconColor={iconColor}
      title={title}
      badge={badge}
      padded={false}
      action={action && (
        <button onClick={onAction} className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5">
          {action} <ArrowRight className="w-3 h-3" />
        </button>
      )}
    >
      {children}
    </Card>
  )
}


/* A few placeholder rows while a tile's data loads. */
function TileLoading() {
  return (
    <div className="px-4 py-3 space-y-2.5">
      {[0, 1, 2].map(i => <Skeleton key={i} className="h-11 w-full" />)}
    </div>
  )
}


/* ── Page ─────────────────────────────────────────────────────────── */
export default function Dashboard() {
  const navigate = useNavigate()
  const [todayJobs, setTodayJobs] = useState([])
  const [weekJobs, setWeekJobs] = useState([])
  const [invoices, setInvoices] = useState([])
  const [quotes, setQuotes] = useState([])
  const [todayVisits, setTodayVisits] = useState([])
  const [overdueConvs, setOverdueConvs] = useState([])
  const [unassignedConvs, setUnassignedConvs] = useState([])
  const [leads, setLeads] = useState([])
  const [svcRevenue, setSvcRevenue] = useState([])
  const [commsSummary, setCommsSummary] = useState({})
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)

  const t = today()
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

  useEffect(() => {
    const load = async () => {
      try {
        const [
          jobsToday, jobsWeek, invoicesAll, quotesAll,
          visitsToday, conversationsOverdue, conversationsUnassigned, leadsAll, svcRevenueResp, commsSummaryResp, employeesAll,
        ] = await Promise.all([
          get(`/api/jobs?date=${t}`).catch(() => []),
          get(`/api/jobs?date_from=${t}&date_to=${weekEnd}`).catch(() => []),
          get('/api/invoices?limit=200').catch(() => []),
          get('/api/quotes?limit=500').catch(() => []),
          get(`/api/visits?scheduled_date_from=${t}&scheduled_date_to=${t}&limit=100`).catch(() => ({ items: [] })),
          get('/api/comms/conversations?sla_state=breached&status=open&limit=20').catch(() => ({ items: [] })),
          get('/api/comms/conversations?assignee=unassigned&status=open&limit=20').catch(() => ({ items: [] })),
          get('/api/intake?limit=200').catch(() => []),
          get('/api/invoices/summary/by-service?period=mtd').catch(() => ({ by_service: [] })),
          get('/api/comms/conversations/summary').catch(() => ({})),
          get('/api/dispatch/employees').catch(() => []),
        ])
        setTodayJobs(Array.isArray(jobsToday) ? jobsToday : [])
        setWeekJobs(Array.isArray(jobsWeek) ? jobsWeek : [])
        setInvoices(Array.isArray(invoicesAll) ? invoicesAll : [])
        setQuotes(Array.isArray(quotesAll) ? quotesAll : (quotesAll?.items || []))
        const tv = Array.isArray(visitsToday) ? visitsToday : (visitsToday?.items || [])
        setTodayVisits(tv)
        setOverdueConvs(Array.isArray(conversationsOverdue) ? conversationsOverdue : (conversationsOverdue?.items || []))
        setUnassignedConvs(Array.isArray(conversationsUnassigned) ? conversationsUnassigned : (conversationsUnassigned?.items || []))
        setLeads(Array.isArray(leadsAll) ? leadsAll : (leadsAll?.items || []))
        setSvcRevenue(Array.isArray(svcRevenueResp?.by_service) ? svcRevenueResp.by_service : [])
        setCommsSummary(commsSummaryResp && typeof commsSummaryResp === 'object' ? commsSummaryResp : {})
        setEmployees(Array.isArray(employeesAll) ? employeesAll : (employeesAll?.items || []))
      } catch (e) { console.error('[Dashboard] load:', e) }
      setLoading(false)
    }
    load()
  }, [])

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
  const pipeline = useMemo(() => quotes
    .filter(q => ['sent', 'draft'].includes(q.status))
    .reduce((s, q) => s + (q.total || 0), 0), [quotes])
  const overdueInvoiceCount = invoices.filter(i => i.status === 'overdue').length

  // Quotes & leads that need the owner to do something next.
  const quoteActions = useMemo(() => ({
    awaiting: quotes.filter(q => ['sent', 'viewed'].includes(q.status)).length,
    changes: quotes.filter(q => q.status === 'changes_requested').length,
    toSchedule: quotes.filter(q => q.status === 'accepted').length,
    newLeads: leads.filter(l => !l.status || ['new', 'received'].includes(l.status)).length,
  }), [quotes, leads])

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
        sub: c.preview || 'Awaiting reply',
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
        title: `Late start · ${v.job?.title || `Visit #${v.id}`}`,
        sub: `${(v.start_time || '').slice(0, 5)} · ${v.property?.name || ''}`,
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
        sub: c.preview || '',
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
        onClick: () => navigate('/invoicing'),
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

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-5 sm:pt-6 pb-4">
        <div className="text-[10px] sm:text-[11px] font-semibold text-indigo-500 uppercase tracking-[0.14em]">
          Command Center
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-ink mt-0.5">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </h1>
        <p className="text-[12px] text-ink-3 mt-1">
          {todayCount === 0 ? 'No jobs today' : `${todayCount} job${todayCount > 1 ? 's' : ''} today`}
          {' · '}
          {weekCount} this week
          {attention.length > 0 && ` · ${attention.length} need attention`}
        </p>
      </div>

      {/* Two stacked tiles on top, money below */}
      <div className="px-4 sm:px-6 pb-8 grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* INBOX — what needs attention */}
        <Tile
          icon={Inbox}
          iconColor="text-blue-500"
          title="Inbox needs attention"
          badge={(attention.length > 0 || slaBreached > 0) && (
            <span className="flex items-center gap-1">
              {slaBreached > 0 && (
                <span className="text-[10px] font-bold text-white bg-red-500 px-1.5 py-0.5 rounded-full" title="Conversations past their response SLA">
                  {slaBreached} SLA
                </span>
              )}
              {attention.length > 0 && (
                <span className="text-[10px] font-bold text-ink-3 bg-bg-2 px-1.5 py-0.5 rounded-full">
                  {attention.length}
                </span>
              )}
            </span>
          )}
          action="Open Comms"
          onAction={() => navigate('/comms')}
        >
          {loading ? (
            <TileLoading />
          ) : attention.length === 0 ? (
            <EmptyState compact icon={CheckCircle2} title="All clear"
              description="Nothing urgent right now." />
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[380px]">
              {attention.map(p => (
                <AttentionRow key={p.key} {...p} />
              ))}
              {/* Per-category overflow: route each "+N more" to the page
                  where those items actually live. /comms doesn't surface
                  late visits or overdue invoices, so the CTA needs to
                  match the category. */}
              {(hiddenOverdueConvs + hiddenUnassignedConvs > 0) && (
                <button
                  onClick={() => navigate('/comms')}
                  className="w-full text-left px-4 py-2 text-[10px] text-ink-3 hover:text-blue-600 hover:bg-bg transition-colors"
                >
                  +{hiddenOverdueConvs + hiddenUnassignedConvs} more in inbox · Open Comms →
                </button>
              )}
              {hiddenLateVisits > 0 && (
                <button
                  onClick={() => navigate('/schedule')}
                  className="w-full text-left px-4 py-2 text-[10px] text-ink-3 hover:text-blue-600 hover:bg-bg transition-colors"
                >
                  +{hiddenLateVisits} more late {hiddenLateVisits === 1 ? 'visit' : 'visits'} · Open Schedule →
                </button>
              )}
              {hiddenInvoices > 0 && (
                <button
                  onClick={() => navigate('/invoicing')}
                  className="w-full text-left px-4 py-2 text-[10px] text-ink-3 hover:text-blue-600 hover:bg-bg transition-colors"
                >
                  +{hiddenInvoices} more past-due {hiddenInvoices === 1 ? 'invoice' : 'invoices'} · Open Invoicing →
                </button>
              )}
            </div>
          )}
        </Tile>

        {/* TODAY — schedule preview, no calendar widget */}
        <Tile
          icon={Calendar}
          iconColor="text-violet-500"
          title="Today's schedule"
          badge={todayCount > 0 && (
            <span className="text-[10px] font-bold text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded-full">
              {todayCount}
            </span>
          )}
          action="Open Schedule"
          onAction={() => navigate('/schedule')}
        >
          {loading ? (
            <TileLoading />
          ) : todayJobs.length === 0 ? (
            <EmptyState compact icon={Calendar} title="Nothing scheduled today"
              description={weekCount > 0 ? `${weekCount} jobs later this week` : undefined} />
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[380px]">
              {todayJobs.map(j => (
                <button
                  key={j.id}
                  onClick={() => navigate('/schedule')}
                  className="w-full text-left flex items-baseline gap-3 px-4 py-3 hover:bg-bg active:bg-bg-2 transition-colors border-b border-hairline last:border-b-0"
                >
                  <span className="text-[12px] font-semibold text-ink tabular-nums shrink-0 w-12">
                    {(j.start_time || '').slice(0, 5) || '—'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-ink truncate">{j.title}</span>
                    {j.address && (
                      <span className="block text-[11px] text-ink-3 truncate mt-0.5">{j.address}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Tile>

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
          onAction={() => navigate('/quoting?tab=quotes')}
        >
          {loading ? (
            <TileLoading />
          ) : (quoteActions.awaiting + quoteActions.changes + quoteActions.toSchedule + quoteActions.newLeads) === 0 ? (
            <EmptyState compact icon={CheckCircle2} title="Funnel clear"
              description="No quotes or leads waiting on you." />
          ) : (
            <div className="flex-1 space-y-1.5">
              {[
                { n: quoteActions.changes, label: 'Changes requested', tone: 'text-amber-700 bg-amber-50 border-amber-200', go: () => navigate('/quoting?tab=quotes') },
                { n: quoteActions.awaiting, label: 'Awaiting customer response', tone: 'text-blue-700 bg-blue-50 border-blue-200', go: () => navigate('/quoting?tab=quotes') },
                { n: quoteActions.toSchedule, label: 'Accepted — ready to schedule', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200', go: () => navigate('/quoting?tab=quotes') },
                { n: quoteActions.newLeads, label: 'New leads to quote', tone: 'text-purple-700 bg-purple-50 border-purple-200', go: () => navigate('/quoting?tab=leads') },
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
          onAction={() => navigate('/invoicing')}
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
              onClick={() => navigate('/invoicing')}
            />
            <StatCard
              className="bg-panel"
              label="Pipeline"
              value={fmtMoney(pipeline)}
              sub={`${quotes.filter(q => q.status === 'sent').length} sent · ${quotes.filter(q => q.status === 'draft').length} draft`}
              accent="text-emerald-600"
              onClick={() => navigate('/quoting')}
            />
          </div>

          {/* AR Aging — who to call this morning */}
          {(arAging['30'].length + arAging['60'].length + arAging['90'].length) > 0 && (
            <div className="border-t border-hairline px-4 py-3">
              <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2">Aging receivables</div>
              <div className="flex gap-3 text-[12px]">
                {arAging['30'].length > 0 && (
                  <button onClick={() => navigate('/invoicing')} className="flex items-baseline gap-1 hover:text-amber-700 transition-colors">
                    <span className="text-amber-600 font-bold">{fmtMoney(arAging['30'].reduce((s, i) => s + (i.total || 0), 0))}</span>
                    <span className="text-ink-3">30-60d</span>
                  </button>
                )}
                {arAging['60'].length > 0 && (
                  <button onClick={() => navigate('/invoicing')} className="flex items-baseline gap-1 hover:text-orange-700 transition-colors">
                    <span className="text-orange-600 font-bold">{fmtMoney(arAging['60'].reduce((s, i) => s + (i.total || 0), 0))}</span>
                    <span className="text-ink-3">60-90d</span>
                  </button>
                )}
                {arAging['90'].length > 0 && (
                  <button onClick={() => navigate('/invoicing')} className="flex items-baseline gap-1 hover:text-red-700 transition-colors">
                    <span className="text-red-600 font-bold">{fmtMoney(arAging['90'].reduce((s, i) => s + (i.total || 0), 0))}</span>
                    <span className="text-ink-3">90d+</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Revenue by service type (paid, month-to-date) */}
          {svcRevenue.length > 0 && (
            <div className="border-t border-hairline px-4 py-3">
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
