import { useMemo } from 'react'
import {
  DollarSign, AlertCircle, CalendarCheck, Repeat, CheckCircle2, Clock,
  FileText, Receipt, Home, Briefcase, MessageSquare, TrendingUp, Mail,
  CalendarDays, ChevronRight, Pencil, ArrowRight,
} from 'lucide-react'
import Card from '../ui/Card'
import StatCard from '../ui/StatCard'
import { formatDateShort } from '../../utils/format'
import {
  DOT, QUOTE_COLORS, INVOICE_COLORS, JOB_COLORS, OPP_COLORS, PROPERTY_TYPE_COLORS,
} from './constants'

/**
 * ClientOverview — the "Customer 360" landing for a client profile.
 *
 * One calm, scannable page that tells the whole customer story in funnel order —
 * Request → Deal → Quotes → Jobs → Invoices → Properties — so nothing has to be
 * hunted for across tabs. Everything renders from data the profile already
 * loaded in one batch; this view fires NO extra requests (brightbase-economy).
 * Status is always the quiet dot+word; every record is a link to its own page.
 */

const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
const LINK = 'text-ink hover:text-indigo-600 no-underline font-medium'

// dot + sentence-case word, the app's one status vocabulary (no pills, no bubbles).
function Status({ map, value }) {
  if (!value) return null
  const color = map[value] || 'bg-ink-3'
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-3 shrink-0">
      <span className={`${DOT} ${color}`} aria-hidden="true" />
      {String(value).replace(/_/g, ' ')}
    </span>
  )
}

// Small uppercase eyebrow over a section title — the quiet hierarchy cue.
function SectionHead({ eyebrow, count, action }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 pt-3 pb-2">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">{eyebrow}</span>
        {count != null && <span className="text-[11px] text-ink-3 tabular-nums">{count}</span>}
      </div>
      {action}
    </div>
  )
}

const viewAll = (onClick, label = 'View all') => (
  <button onClick={onClick} className="text-[11px] text-ink-3 hover:text-indigo-600 shrink-0">{label} →</button>
)

// One record row: title (linked), a line of meta, and a right-aligned value/status.
function Row({ icon: Icon, tone = 'text-ink-3', title, meta, right, onClick }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-3.5 py-2.5 hover:bg-bg-2/60 transition-colors text-left border-t border-hairline first:border-t-0">
      {Icon && <Icon className={`w-4 h-4 shrink-0 ${tone}`} />}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink truncate">{title}</div>
        {meta && <div className="text-[11px] text-ink-3 truncate mt-0.5">{meta}</div>}
      </div>
      {right}
      <ChevronRight className="w-4 h-4 text-ink-3/70 shrink-0" />
    </button>
  )
}

function Empty({ icon: Icon, children }) {
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-6 text-[13px] text-ink-3">
      {Icon && <Icon className="w-4 h-4 shrink-0 text-ink-3/60" />}
      {children}
    </div>
  )
}

function activityLine(item) {
  const d = item.data || {}
  switch (item.type) {
    case 'job': return { icon: Briefcase, tone: 'text-blue-500', text: `Job — ${d.title || 'Cleaning'}` }
    case 'quote': return { icon: FileText, tone: 'text-indigo-500', text: `Quote ${d.quote_number || ''}`.trim() }
    case 'invoice': return { icon: Receipt, tone: 'text-emerald-500', text: `Invoice ${d.invoice_number || ''}`.trim() }
    case 'message': return { icon: MessageSquare, tone: 'text-purple-500', text: `${d.direction === 'inbound' ? 'Received' : 'Sent'} ${d.channel || 'message'}` }
    case 'email': return { icon: Mail, tone: 'text-violet-500', text: d.subject || 'Email' }
    case 'opportunity': return { icon: TrendingUp, tone: 'text-amber-500', text: `Deal — ${d.title || 'Opportunity'}` }
    case 'gcal_event': return { icon: CalendarDays, tone: 'text-cyan-500', text: d.title || 'Calendar event' }
    default: return { icon: Clock, tone: 'text-ink-3', text: d.summary || 'Activity' }
  }
}

export default function ClientOverview({
  client, navigate, setTab, goToScheduleSection,
  totalRevenue, outstanding,
  invoices = [], quotes = [], upcomingJobs = [], pastJobs = [],
  schedules = [], properties = [], visitStats, allActivity = [],
  intakes = [], opportunities = [],
}) {
  const unpaidInvoices = useMemo(
    () => invoices.filter(i => ['sent', 'overdue'].includes(i.status)),
    [invoices],
  )
  const activeSeries = useMemo(() => schedules.filter(s => s.active), [schedules])
  const completedVisits = visitStats?.completed ?? visitStats?.total ?? pastJobs.length
  const nextVisit = upcomingJobs[0]
  // All quotes, newest first — drafts included, so nothing is ever hidden.
  const sortedQuotes = useMemo(
    () => [...quotes].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id - a.id),
    [quotes],
  )
  const recentJobs = useMemo(
    () => [...upcomingJobs, ...pastJobs].slice(0, 5),
    [upcomingJobs, pastJobs],
  )
  const deal = opportunities[0]
  const request = intakes[0]
  const recent = allActivity.slice(0, 6)

  return (
    <div className="space-y-4 max-w-6xl">
      {/* Scoreboard */}
      <Card padded={false}>
        <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-y md:divide-y-0 divide-hairline">
          <StatCard label="Lifetime value" value={money(totalRevenue)} sub="paid to date"
            icon={DollarSign} accent="text-emerald-600" onClick={() => setTab('invoices')} />
          <StatCard label="Balance owed" value={money(outstanding)}
            sub={`${unpaidInvoices.length} unpaid`} icon={AlertCircle}
            accent={outstanding > 0 ? 'text-amber-600' : 'text-ink'} onClick={() => setTab('invoices')} />
          <StatCard label="Visits done" value={completedVisits} sub="completed"
            icon={CheckCircle2} onClick={() => goToScheduleSection?.('client-all-jobs-section')} />
          <StatCard label="Next visit" value={nextVisit ? formatDateShort(nextVisit.scheduled_date) : '—'}
            sub={nextVisit ? (nextVisit.address || 'scheduled') : 'none scheduled'} icon={CalendarCheck}
            accent={nextVisit ? 'text-blue-600' : 'text-ink-3'} onClick={() => setTab('calendar')} />
          <StatCard label="Recurring" value={activeSeries.length} sub="active series"
            icon={Repeat} onClick={() => goToScheduleSection?.('client-recurring-section')} />
        </div>
      </Card>

      {/* How they came in — the origin request and the deal it became, side by
          side with a funnel arrow. The piece the old landing never showed. */}
      {(request || deal) && (
        <Card padded={false}>
          <SectionHead eyebrow="Pipeline" />
          <div className="grid grid-cols-1 shell:grid-cols-[1fr_auto_1fr] items-center gap-2 px-3.5 pb-3.5">
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-wide text-ink-3 mb-1">Came in as</div>
              {request ? (
                <>
                  <button onClick={() => navigate(`/requests/${request.id}`)} className={`${LINK} text-[13px]`}>
                    Request #{request.id}
                  </button>
                  <div className="text-[11px] text-ink-3 truncate mt-0.5">
                    {[request.source, request.service_type, request.created_at && formatDateShort(request.created_at)]
                      .filter(Boolean).join(' · ') || 'direct'}
                  </div>
                </>
              ) : <span className="text-[13px] text-ink-3">Added directly</span>}
            </div>
            <ArrowRight className="hidden shell:block w-4 h-4 text-ink-3/60 mx-2" aria-hidden="true" />
            <div className="min-w-0 shell:border-l shell:border-hairline shell:pl-4 pt-3 shell:pt-0 border-t shell:border-t-0 border-hairline">
              <div className="text-[10.5px] uppercase tracking-wide text-ink-3 mb-1">Deal</div>
              {deal ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => navigate(`/opportunities/${deal.id}`)} className={`${LINK} text-[13px] truncate`}>
                      {deal.title || 'Opportunity'}
                    </button>
                    <span className="text-[13px] font-semibold text-ink tabular-nums shrink-0">{money(deal.amount)}</span>
                  </div>
                  <div className="mt-1"><Status map={OPP_COLORS} value={deal.stage} /></div>
                </>
              ) : <span className="text-[13px] text-ink-3">No open deal</span>}
            </div>
          </div>
        </Card>
      )}

      {/* Funnel body: quotes / jobs / invoices / properties, 2-up on wide. */}
      <div className="grid grid-cols-1 shell:grid-cols-2 gap-4">
        {/* Quotes — ALL of them, newest first. Fixes "I can't find the quote". */}
        <Card padded={false}>
          <SectionHead eyebrow="Quotes" count={quotes.length || null}
            action={quotes.length > 4 ? viewAll(() => setTab('quotes')) : null} />
          {sortedQuotes.length === 0
            ? <Empty icon={FileText}>No quotes yet.</Empty>
            : sortedQuotes.slice(0, 4).map(q => {
              // An accepted quote's clear next step is booking it — send the row
              // straight into the booking flow (?book=1 auto-opens the modal on
              // the quote) and cue it, so it's one tap from the client page
              // instead of hunting for the quote and a buried button.
              const bookable = q.status === 'accepted'
              return (
                <Row key={q.id} icon={FileText} tone="text-indigo-500"
                  title={`${q.quote_number || `Quote ${q.id}`} · ${money(q.total)}`}
                  meta={q.created_at ? formatDateShort(q.created_at) : null}
                  right={bookable
                    ? <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-indigo-600">
                        <CalendarCheck className="w-3.5 h-3.5" /> Book
                      </span>
                    : <Status map={QUOTE_COLORS} value={q.status} />}
                  onClick={() => navigate(`/quotes/${q.id}${bookable ? '?book=1' : ''}`)} />
              )
            })}
        </Card>

        {/* Jobs */}
        <Card padded={false}>
          <SectionHead eyebrow="Jobs" count={(upcomingJobs.length + pastJobs.length) || null}
            action={viewAll(() => setTab('calendar'), 'Schedule')} />
          {recentJobs.length === 0
            ? <Empty icon={Briefcase}>No visits yet.</Empty>
            : recentJobs.map(j => (
              <Row key={j.id} icon={Briefcase} tone="text-blue-500"
                title={`${formatDateShort(j.scheduled_date)} · ${j.title || 'Cleaning'}`}
                meta={j.address || null}
                right={<Status map={JOB_COLORS} value={j.status} />}
                onClick={() => navigate(`/jobs/${j.id}`)} />
            ))}
        </Card>

        {/* Invoices */}
        <Card padded={false}>
          <SectionHead eyebrow="Invoices" count={invoices.length || null}
            action={invoices.length > 4 ? viewAll(() => setTab('invoices')) : null} />
          {invoices.length === 0
            ? <Empty icon={Receipt}>No invoices yet.</Empty>
            : invoices.slice(0, 4).map(inv => (
              <Row key={inv.id} icon={Receipt}
                tone={inv.status === 'overdue' ? 'text-rose-500' : 'text-emerald-500'}
                title={`${inv.invoice_number || `Invoice ${inv.id}`} · ${money(inv.total)}`}
                meta={inv.status === 'overdue' ? 'Overdue'
                  : inv.status === 'paid' ? 'Paid'
                  : inv.due_date ? `Due ${formatDateShort(inv.due_date)}` : null}
                right={<Status map={INVOICE_COLORS} value={inv.status} />}
                onClick={() => navigate(`/invoices/${inv.id}`)} />
            ))}
        </Card>

        {/* Properties */}
        <Card padded={false}>
          <SectionHead eyebrow="Properties" count={properties.length || null}
            action={viewAll(() => setTab('properties'), 'Manage')} />
          {properties.length === 0
            ? <Empty icon={Home}>No properties on file.</Empty>
            : properties.slice(0, 4).map(p => (
              <Row key={p.id} icon={Home}
                title={p.name || p.address || 'Property'}
                meta={p.name ? p.address : null}
                right={<Status map={PROPERTY_TYPE_COLORS} value={p.property_type} />}
                onClick={() => navigate(`/properties/${p.id}`)} />
            ))}
          <button onClick={() => setTab('details')}
            className="w-full flex items-center justify-center gap-1.5 text-[12px] text-ink-2 hover:text-ink py-2.5 border-t border-hairline">
            <Pencil className="w-3.5 h-3.5" /> Edit contact details
          </button>
        </Card>
      </div>

      {/* Recent activity — the running log, kept quiet at the bottom. */}
      <Card padded={false}>
        <SectionHead eyebrow="Recent activity"
          action={allActivity.length > 6 ? viewAll(() => setTab('activity')) : null} />
        {recent.length === 0
          ? <Empty icon={Clock}>Nothing yet.</Empty>
          : (
            <ul>
              {recent.map((item, i) => {
                const line = activityLine(item)
                const Icon = line.icon
                return (
                  <li key={i} className="flex items-center gap-2.5 px-3.5 py-2 border-t border-hairline first:border-t-0">
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${line.tone}`} />
                    <span className="text-[12px] text-ink-2 truncate flex-1">{line.text}</span>
                    <span className="text-[10.5px] text-ink-3 shrink-0 tabular-nums">
                      {item.date ? formatDateShort(item.date) : ''}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
      </Card>
    </div>
  )
}
