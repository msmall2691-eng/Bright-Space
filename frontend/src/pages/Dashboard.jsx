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
import { displayContactName } from '../utils/display'
import {
  Calendar, Inbox, DollarSign, Phone, Mail, MessageSquare,
  CheckCircle2, Clock, ArrowRight, Zap,
} from 'lucide-react'

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => {
  const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}
const fmtMoney = (n) => `$${Math.round(n || 0).toLocaleString()}`

// Format a phone number so the dashboard doesn't show "+16178492813"
// raw. Falls through if the input isn't phone-shaped.
function formatPhone(p) {
  if (!p) return ''
  const digits = p.replace(/\D/g, '')
  if (digits.length === 11 && digits[0] === '1')
    return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`
  if (digits.length === 10)
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
  return p
}

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
  }[tone] || 'bg-zinc-400'
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 active:bg-zinc-100 transition-colors border-b border-zinc-100 last:border-b-0"
    >
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
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


/* ── Money stat — compact horizontal cell ─────────────────────────── */
function MoneyStat({ label, value, sub, accent = 'text-zinc-900', onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-left p-4 rounded-xl hover:bg-zinc-50 active:bg-zinc-100 transition-colors disabled:opacity-100"
      disabled={!onClick}
    >
      <div className="text-[10px] font-semibold text-zinc-400 uppercase tracking-[0.14em]">{label}</div>
      <div className={`text-xl sm:text-2xl font-bold mt-1.5 ${accent}`}>{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 mt-1">{sub}</div>}
    </button>
  )
}


/* ── Tile shell ────────────────────────────────────────────────────── */
function Tile({ icon: Ic, iconColor, title, badge, action, onAction, children }) {
  return (
    <section className="bg-white border border-zinc-200 rounded-2xl flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          {Ic && <Ic className={`w-4 h-4 ${iconColor}`} />}
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          {badge}
        </div>
        {action && (
          <button onClick={onAction} className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5">
            {action} <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      {children}
    </section>
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
  const [loading, setLoading] = useState(true)

  const t = today()
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

  useEffect(() => {
    const load = async () => {
      try {
        const [
          jobsToday, jobsWeek, invoicesAll, quotesAll,
          visitsToday, conversationsOverdue, conversationsUnassigned,
        ] = await Promise.all([
          get(`/api/jobs?date=${t}`).catch(() => []),
          get(`/api/jobs?date_from=${t}&date_to=${weekEnd}`).catch(() => []),
          get('/api/invoices').catch(() => []),
          get('/api/quotes').catch(() => []),
          get(`/api/visits?scheduled_date_from=${t}&scheduled_date_to=${t}&limit=100`).catch(() => ({ items: [] })),
          get('/api/comms/conversations?sla_state=breached&status=open&limit=20').catch(() => ({ items: [] })),
          get('/api/comms/conversations?assignee=unassigned&status=open&limit=20').catch(() => ({ items: [] })),
        ])
        setTodayJobs(Array.isArray(jobsToday) ? jobsToday : [])
        setWeekJobs(Array.isArray(jobsWeek) ? jobsWeek : [])
        setInvoices(Array.isArray(invoicesAll) ? invoicesAll : [])
        setQuotes(Array.isArray(quotesAll) ? quotesAll : (quotesAll?.items || []))
        const tv = Array.isArray(visitsToday) ? visitsToday : (visitsToday?.items || [])
        setTodayVisits(tv)
        setOverdueConvs(Array.isArray(conversationsOverdue) ? conversationsOverdue : (conversationsOverdue?.items || []))
        setUnassignedConvs(Array.isArray(conversationsUnassigned) ? conversationsUnassigned : (conversationsUnassigned?.items || []))
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

  /* ── Unified attention list, deduped on conversation id so the same
        thread can't appear as both overdue AND unassigned. ── */
  const attention = useMemo(() => {
    const items = []
    const seenConvs = new Set()
    const nowHHMM = new Date().toTimeString().slice(0, 5)

    overdueConvs.forEach(c => {
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
      .forEach(v => items.push({
        key: `late-${v.id}`,
        tone: 'amber',
        title: `Late start · ${v.job?.title || `Visit #${v.id}`}`,
        sub: `${(v.start_time || '').slice(0, 5)} · ${v.property?.name || ''}`,
        action: 'Open',
        onClick: () => navigate('/schedule'),
      }))

    unassignedConvs.forEach(c => {
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

  const todayCount = todayJobs.length
  const weekCount = weekJobs.length

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-5 sm:pt-6 pb-4">
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
          badge={attention.length > 0 && (
            <span className="text-[10px] font-bold text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded-full">
              {attention.length}
            </span>
          )}
          action="Open Comms"
          onAction={() => navigate('/comms')}
        >
          {loading ? (
            <div className="py-8 text-center text-[12px] text-zinc-400">Loading…</div>
          ) : attention.length === 0 ? (
            <div className="py-10 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-2" />
              <p className="text-[13px] text-zinc-500">All clear · nothing urgent</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[380px]">
              {attention.slice(0, 8).map(p => (
                <AttentionRow key={p.key} {...p} />
              ))}
              {attention.length > 8 && (
                <div className="px-4 py-2 text-[10px] text-zinc-400">
                  +{attention.length - 8} more · open Comms to see all
                </div>
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
            <div className="py-8 text-center text-[12px] text-zinc-400">Loading…</div>
          ) : todayJobs.length === 0 ? (
            <div className="py-10 text-center">
              <Calendar className="w-6 h-6 text-zinc-300 mx-auto mb-2" />
              <p className="text-[13px] text-zinc-500">Nothing scheduled today</p>
              {weekCount > 0 && (
                <p className="text-[11px] text-zinc-400 mt-1">{weekCount} jobs later this week</p>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[380px]">
              {todayJobs.map(j => (
                <button
                  key={j.id}
                  onClick={() => navigate('/schedule')}
                  className="w-full text-left flex items-baseline gap-3 px-4 py-3 hover:bg-zinc-50 active:bg-zinc-100 transition-colors border-b border-zinc-100 last:border-b-0"
                >
                  <span className="text-[12px] font-semibold text-zinc-900 tabular-nums shrink-0 w-12">
                    {(j.start_time || '').slice(0, 5) || '—'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-zinc-900 truncate">{j.title}</span>
                    {j.address && (
                      <span className="block text-[11px] text-zinc-500 truncate mt-0.5">{j.address}</span>
                    )}
                  </span>
                </button>
              ))}
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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-zinc-100">
            <div className="bg-white">
              <MoneyStat
                label="Today"
                value={fmtMoney(todayRevenue)}
                sub={todayRevenue > 0 ? 'collected today' : 'nothing collected yet'}
              />
            </div>
            <div className="bg-white">
              <MoneyStat
                label="Month to date"
                value={fmtMoney(mtdRevenue)}
                sub={`${invoices.filter(i => i.status === 'paid').length} paid`}
              />
            </div>
            <div className="bg-white">
              <MoneyStat
                label="Outstanding"
                value={fmtMoney(outstanding)}
                sub={`${invoices.filter(i => ['sent','overdue'].includes(i.status)).length} unpaid${overdueInvoiceCount > 0 ? ` · ${overdueInvoiceCount} overdue` : ''}`}
                accent={overdueInvoiceCount > 0 ? 'text-amber-600' : 'text-zinc-900'}
                onClick={() => navigate('/invoicing')}
              />
            </div>
            <div className="bg-white">
              <MoneyStat
                label="Pipeline"
                value={fmtMoney(pipeline)}
                sub={`${quotes.filter(q => q.status === 'sent').length} sent · ${quotes.filter(q => q.status === 'draft').length} draft`}
                accent="text-emerald-600"
                onClick={() => navigate('/quoting')}
              />
            </div>
          </div>
        </Tile>
        </div>

      </div>
    </div>
  )
}
