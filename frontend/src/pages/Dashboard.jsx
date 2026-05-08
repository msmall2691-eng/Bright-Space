/**
 * Dashboard — Command Center.
 *
 * Three-column layout (stacks on mobile):
 *   Top:    4 KPI tiles  (Today · Month-to-date · Outstanding · Pipeline)
 *   Bottom: Priorities  ·  Unified Inbox  ·  Schedule
 *
 * Each panel reuses the existing API surface — no backend changes. The
 * priorities feed is derived client-side from a few endpoints (overdue
 * conversations, unassigned, past-due invoices, draft quotes, today's
 * scheduled visits whose start_time has passed).
 */
import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { get } from '../api'
import { displayContactName } from '../utils/display'
import {
  Calendar, DollarSign, FileText, Clock, AlertCircle, ArrowRight,
  Inbox, Phone, Mail, MessageSquare, Activity, Navigation2,
  CheckCircle2, GitBranch, RefreshCw, ArrowUpRight, Zap,
} from 'lucide-react'

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => {
  const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}
const fmtMoney = (n) => `$${Math.round(n || 0).toLocaleString()}`
const channelIcon = (ch) => ({ sms: Phone, email: Mail, chat: MessageSquare }[ch] || MessageSquare)
const channelColor = (ch) => ({
  sms:   'bg-emerald-50 text-emerald-700',
  email: 'bg-blue-50 text-blue-700',
  chat:  'bg-violet-50 text-violet-700',
}[ch] || 'bg-zinc-100 text-zinc-600')


/* ── KPI tile ──────────────────────────────────────────────────── */
function KpiTile({ label, value, sub, accent = 'text-zinc-900' }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-2xl p-4 sm:p-5">
      <div className="text-[10px] sm:text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.14em]">{label}</div>
      <div className={`text-2xl sm:text-3xl font-bold mt-2 ${accent}`}>{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 mt-1.5">{sub}</div>}
    </div>
  )
}


/* ── Priority row ──────────────────────────────────────────────── */
function PriorityRow({ dot, title, sub, action, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 active:bg-zinc-100 transition-colors border-b border-zinc-100 last:border-b-0"
    >
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-zinc-900 truncate">{title}</div>
        {sub && <div className="text-[11px] text-zinc-500 mt-0.5 truncate">{sub}</div>}
      </div>
      {action && (
        <span className="text-[11px] font-semibold text-blue-600 shrink-0 mt-1.5">{action}</span>
      )}
    </button>
  )
}


/* ── Compact inbox row ─────────────────────────────────────────── */
function InboxRow({ conv, onClick }) {
  const name = displayContactName(conv.client) || conv.external_contact || 'Unknown'
  const unread = conv.unread_count > 0
  const overdue = conv.sla_state === 'breached'
  const Ic = channelIcon(conv.channel)
  const ts = conv.last_message_at ? relTime(conv.last_message_at) : ''
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 active:bg-zinc-100 transition-colors border-b border-zinc-100 last:border-b-0"
    >
      <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${channelColor(conv.channel)}`}>
        <Ic className="w-3.5 h-3.5" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-[13px] truncate flex-1 ${unread ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'}`}>{name}</span>
          <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums">{ts}</span>
        </div>
        <div className={`text-[11.5px] truncate mt-0.5 ${unread ? 'text-zinc-600' : 'text-zinc-400'}`}>{conv.preview || 'No messages yet'}</div>
        {overdue && (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold mt-1 px-1.5 py-px rounded bg-red-50 text-red-700 border border-red-100">
            <Clock className="w-2.5 h-2.5" /> Overdue
          </span>
        )}
      </div>
      {unread && (
        <span className="bg-blue-600 text-white text-[10px] font-bold min-w-[18px] h-[18px] px-1.5 rounded-full flex items-center justify-center shrink-0 mt-1">
          {conv.unread_count > 9 ? '9+' : conv.unread_count}
        </span>
      )}
    </button>
  )
}

function relTime(iso) {
  const d = new Date(iso); const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}


/* ── Mini month calendar with dots ─────────────────────────────── */
function MiniCalendar({ datesWithJobs, onPick }) {
  const now = new Date()
  const year = now.getFullYear(), month = now.getMonth()
  const first = new Date(year, month, 1)
  const last = new Date(year, month + 1, 0)
  const totalDays = last.getDate()
  const startDow = first.getDay()
  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= totalDays; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  const todayISO = today()
  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  return (
    <div className="px-4 pb-4">
      <div className="text-[11px] font-semibold text-zinc-500 mb-2">{monthName}</div>
      <div className="grid grid-cols-7 gap-px text-center">
        {['S','M','T','W','T','F','S'].map((d, i) => (
          <div key={i} className="text-[9px] font-semibold text-zinc-400 py-1">{d}</div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={i} />
          const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          const isToday = iso === todayISO
          const has = datesWithJobs.has(iso)
          return (
            <button
              key={i}
              onClick={() => onPick?.(iso)}
              className={`relative text-[11px] py-1.5 rounded ${
                isToday ? 'bg-blue-600 text-white font-semibold' : 'text-zinc-700 hover:bg-zinc-100'
              }`}
            >
              {d}
              {has && !isToday && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-blue-500" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}


/* ── Page ──────────────────────────────────────────────────────── */
export default function Dashboard() {
  const navigate = useNavigate()
  const [todayJobs, setTodayJobs] = useState([])
  const [weekJobs, setWeekJobs] = useState([])
  const [invoices, setInvoices] = useState([])
  const [quotes, setQuotes] = useState([])
  const [intakeStats, setIntakeStats] = useState({})
  const [todayVisits, setTodayVisits] = useState([])
  const [openConvs, setOpenConvs] = useState([])
  const [overdueConvs, setOverdueConvs] = useState([])
  const [unassignedConvs, setUnassignedConvs] = useState([])
  const [loading, setLoading] = useState(true)

  const t = today()
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

  useEffect(() => {
    const load = async () => {
      try {
        const [
          jobsToday, jobsWeek, invoicesAll, quotesAll, intakeStatsRes,
          visitsToday, conversationsOpen, conversationsOverdue, conversationsUnassigned,
        ] = await Promise.all([
          get(`/api/jobs?date=${t}`).catch(() => []),
          get(`/api/jobs?date_from=${t}&date_to=${weekEnd}`).catch(() => []),
          get('/api/invoices').catch(() => []),
          get('/api/quotes').catch(() => []),
          get('/api/intake/stats').catch(() => ({})),
          get(`/api/visits?scheduled_date_from=${t}&scheduled_date_to=${t}&limit=100`).catch(() => ({ items: [] })),
          get('/api/comms/conversations?status=open&limit=10').catch(() => ({ items: [] })),
          get('/api/comms/conversations?sla_state=breached&status=open&limit=20').catch(() => ({ items: [] })),
          get('/api/comms/conversations?assignee=unassigned&status=open&limit=20').catch(() => ({ items: [] })),
        ])
        setTodayJobs(Array.isArray(jobsToday) ? jobsToday : [])
        setWeekJobs(Array.isArray(jobsWeek) ? jobsWeek : [])
        setInvoices(Array.isArray(invoicesAll) ? invoicesAll : [])
        setQuotes(Array.isArray(quotesAll) ? quotesAll : (quotesAll?.items || []))
        setIntakeStats(intakeStatsRes && typeof intakeStatsRes === 'object' ? intakeStatsRes : {})
        const tv = Array.isArray(visitsToday) ? visitsToday : (visitsToday?.items || [])
        setTodayVisits(tv)
        setOpenConvs(Array.isArray(conversationsOpen) ? conversationsOpen : (conversationsOpen?.items || []))
        setOverdueConvs(Array.isArray(conversationsOverdue) ? conversationsOverdue : (conversationsOverdue?.items || []))
        setUnassignedConvs(Array.isArray(conversationsUnassigned) ? conversationsUnassigned : (conversationsUnassigned?.items || []))
      } catch (e) { console.error('[Dashboard] load:', e) }
      setLoading(false)
    }
    load()
  }, [])

  /* ── KPI calcs ── */
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

  /* ── Priorities derivation ── */
  const priorities = useMemo(() => {
    const items = []
    const nowHHMM = new Date().toTimeString().slice(0, 5)

    overdueConvs.slice(0, 3).forEach(c => items.push({
      key: `od-${c.id}`,
      dot: 'bg-red-500',
      title: `Overdue reply · ${displayContactName(c.client) || c.external_contact || 'Unknown'}`,
      sub: c.preview || 'Awaiting reply',
      action: 'Reply',
      onClick: () => navigate('/comms'),
    }))

    todayVisits
      .filter(v => v.status === 'scheduled' && (v.start_time || '').slice(0, 5) < nowHHMM)
      .slice(0, 3)
      .forEach(v => items.push({
        key: `late-${v.id}`,
        dot: 'bg-amber-500',
        title: `Late start · ${v.job?.title || `Visit #${v.id}`}`,
        sub: `${(v.start_time || '').slice(0, 5)} · ${v.property?.name || ''}`,
        action: 'Open',
        onClick: () => navigate('/schedule'),
      }))

    unassignedConvs.slice(0, 2).forEach(c => items.push({
      key: `un-${c.id}`,
      dot: 'bg-amber-400',
      title: `Unassigned · ${displayContactName(c.client) || c.external_contact || 'Unknown'}`,
      sub: c.preview || '',
      action: 'Assign',
      onClick: () => navigate('/comms'),
    }))

    invoices
      .filter(i => i.status === 'overdue')
      .slice(0, 2)
      .forEach(i => items.push({
        key: `inv-${i.id}`,
        dot: 'bg-rose-500',
        title: `Past-due invoice · ${fmtMoney(i.total)}`,
        sub: `Invoice #${i.id}${i.client_name ? ` · ${i.client_name}` : ''}`,
        action: 'Call',
        onClick: () => navigate('/invoicing'),
      }))

    return items.slice(0, 7)
  }, [overdueConvs, todayVisits, unassignedConvs, invoices, navigate])

  /* ── Mini calendar dots ── */
  const datesWithJobs = useMemo(() => {
    const s = new Set()
    weekJobs.forEach(j => { if (j.scheduled_date) s.add(j.scheduled_date.slice(0, 10)) })
    return s
  }, [weekJobs])

  const todayCount = todayJobs.length
  const weekCount = weekJobs.length

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-5 sm:pt-6 pb-4">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <div className="text-[10px] sm:text-[11px] font-semibold text-indigo-500 uppercase tracking-[0.14em]">
              Command Center
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-zinc-900 mt-0.5">
              {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            </h1>
            <p className="text-[12px] text-zinc-500 mt-1">
              {todayCount === 0 ? 'No jobs today' : `${todayCount} job${todayCount > 1 ? 's' : ''} today`}
              {' · '}
              {weekCount} this week
              {priorities.length > 0 && ` · ${priorities.length} need attention`}
            </p>
          </div>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="px-4 sm:px-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <KpiTile label="Today"          value={fmtMoney(todayRevenue)} sub={todayRevenue > 0 ? 'collected today' : 'nothing collected yet'} accent="text-zinc-900" />
          <KpiTile label="Month to date"  value={fmtMoney(mtdRevenue)}   sub={`${invoices.filter(i => i.status === 'paid').length} paid invoices`} />
          <KpiTile label="Outstanding AR" value={fmtMoney(outstanding)}  sub={`${invoices.filter(i => ['sent','overdue'].includes(i.status)).length} unpaid · ${invoices.filter(i => i.status === 'overdue').length} overdue`} accent={outstanding > 0 ? 'text-amber-600' : 'text-zinc-900'} />
          <KpiTile label="Pipeline"       value={fmtMoney(pipeline)}     sub={`${quotes.filter(q => q.status === 'sent').length} sent · ${quotes.filter(q => q.status === 'draft').length} draft`} accent="text-emerald-600" />
        </div>
      </div>

      {/* Three-column main */}
      <div className="px-4 sm:px-6 pt-5 sm:pt-6 pb-8 grid grid-cols-1 lg:grid-cols-12 gap-4">

        {/* Priorities — 4 cols */}
        <section className="lg:col-span-4 bg-white border border-zinc-200 rounded-2xl flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-semibold text-zinc-900">Today's priorities</h2>
              {priorities.length > 0 && (
                <span className="text-[10px] font-bold text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded-full">{priorities.length}</span>
              )}
            </div>
          </div>
          {loading ? (
            <div className="py-8 text-center text-[12px] text-zinc-400">Loading…</div>
          ) : priorities.length === 0 ? (
            <div className="py-10 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-2" />
              <p className="text-[13px] text-zinc-500">All clear · nothing urgent</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[420px]">
              {priorities.map(p => (
                <PriorityRow
                  key={p.key}
                  dot={p.dot}
                  title={p.title}
                  sub={p.sub}
                  action={p.action}
                  onClick={p.onClick}
                />
              ))}
            </div>
          )}
        </section>

        {/* Inbox — 5 cols */}
        <section className="lg:col-span-5 bg-white border border-zinc-200 rounded-2xl flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <div className="flex items-center gap-2">
              <Inbox className="w-4 h-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-zinc-900">Unified inbox</h2>
              {openConvs.filter(c => c.unread_count > 0).length > 0 && (
                <span className="text-[10px] font-bold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded-full">
                  {openConvs.filter(c => c.unread_count > 0).length} new
                </span>
              )}
            </div>
            <button onClick={() => navigate('/comms')} className="text-[11px] font-semibold text-blue-600 hover:text-blue-700">
              Open Comms →
            </button>
          </div>
          {loading ? (
            <div className="py-8 text-center text-[12px] text-zinc-400">Loading…</div>
          ) : openConvs.length === 0 ? (
            <div className="py-10 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-2" />
              <p className="text-[13px] text-zinc-500">Inbox zero · nothing waiting</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[420px]">
              {openConvs.slice(0, 8).map(c => (
                <InboxRow key={c.id} conv={c} onClick={() => navigate('/comms')} />
              ))}
            </div>
          )}
        </section>

        {/* Schedule — 3 cols */}
        <section className="lg:col-span-3 bg-white border border-zinc-200 rounded-2xl flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-violet-500" />
              <h2 className="text-sm font-semibold text-zinc-900">Schedule</h2>
            </div>
            <button onClick={() => navigate('/schedule?view=month')} className="text-[11px] font-semibold text-blue-600 hover:text-blue-700">
              Open →
            </button>
          </div>
          <MiniCalendar datesWithJobs={datesWithJobs} onPick={() => navigate('/schedule?view=month')} />
          <div className="border-t border-zinc-100">
            <div className="px-4 py-2 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Today</div>
            {todayJobs.length === 0 ? (
              <div className="px-4 pb-4 text-[12px] text-zinc-400">Nothing scheduled today.</div>
            ) : (
              <div className="max-h-[180px] overflow-y-auto pb-2">
                {todayJobs.slice(0, 5).map(j => (
                  <button
                    key={j.id}
                    onClick={() => navigate('/schedule?view=month')}
                    className="w-full text-left px-4 py-2 hover:bg-zinc-50 flex items-baseline gap-2"
                  >
                    <span className="text-[11px] font-semibold text-zinc-900 tabular-nums shrink-0">
                      {(j.start_time || '').slice(0, 5) || '—'}
                    </span>
                    <span className="text-[12px] text-zinc-700 truncate flex-1">{j.title}</span>
                  </button>
                ))}
                {todayJobs.length > 5 && (
                  <div className="px-4 py-1 text-[10px] text-zinc-400">+{todayJobs.length - 5} more</div>
                )}
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  )
}
