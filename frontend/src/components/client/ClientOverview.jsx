import { useMemo } from 'react'
import {
  DollarSign, AlertCircle, CalendarCheck, Repeat, CheckCircle2, Clock,
  FileText, Receipt, Home, Briefcase, MessageSquare, TrendingUp, Mail,
  CalendarDays, Eye, ChevronRight, Pencil, Inbox,
} from 'lucide-react'
import Card from '../ui/Card'
import StatCard from '../ui/StatCard'
import RecordLink from '../RecordLink'
import { formatDateShort } from '../../utils/format'

/**
 * ClientOverview — the "Customer 360" landing for a client profile.
 *
 * One at-a-glance screen that answers "what's going on with this customer?":
 * a KPI strip (lifetime value, balance owed, visits, next visit, active
 * recurring), a "needs attention" panel (open quotes + unpaid invoices), the
 * next few visits, and a compact recent-activity feed. All from data the
 * profile already loads — no extra fetches. Every card deep-links into the
 * matching tab for the full list.
 */

const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`

// Compact one-liner per unified-activity item (same shape the Timeline uses).
function activityLine(item) {
  const d = item.data || {}
  switch (item.type) {
    case 'job': return { icon: Briefcase, tone: 'text-blue-500', text: `Job — ${d.title || 'Cleaning'}`, sub: d.status }
    case 'quote': return { icon: FileText, tone: 'text-indigo-500', text: `Quote ${d.quote_number || ''}`.trim(), sub: d.status }
    case 'invoice': return { icon: Receipt, tone: 'text-emerald-500', text: `Invoice ${d.invoice_number || ''}`.trim(), sub: d.status }
    case 'message': return { icon: MessageSquare, tone: 'text-purple-500', text: `${d.direction === 'inbound' ? 'Received' : 'Sent'} ${d.channel || 'message'}`, sub: null }
    case 'email': return { icon: Mail, tone: 'text-violet-500', text: d.subject || 'Email', sub: null }
    case 'opportunity': return { icon: TrendingUp, tone: 'text-amber-500', text: `Deal — ${d.title || 'Opportunity'}`, sub: d.stage }
    case 'gcal_event': return { icon: CalendarDays, tone: 'text-cyan-500', text: d.title || 'Calendar event', sub: null }
    case 'activity_log':
    default: return { icon: Clock, tone: 'text-ink-3', text: d.summary || 'Activity', sub: null }
  }
}

function AttentionRow({ icon: Icon, tone, title, meta, onClick, badge }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-bg-2/60 transition-colors text-left">
      <Icon className={`w-4 h-4 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink truncate">{title}</div>
        {meta && <div className="text-[11px] text-ink-3 truncate">{meta}</div>}
      </div>
      {badge}
      <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" />
    </button>
  )
}

export default function ClientOverview({
  client, navigate, setTab,
  totalRevenue, outstanding,
  invoices = [], quotes = [], upcomingJobs = [], pastJobs = [],
  schedules = [], properties = [], visitStats, allActivity = [],
  intakes = [],
}) {
  const openQuotes = useMemo(
    () => quotes.filter(q => ['sent', 'viewed', 'changes_requested'].includes(q.status)),
    [quotes],
  )
  const unpaidInvoices = useMemo(
    () => invoices.filter(i => ['sent', 'overdue'].includes(i.status)),
    [invoices],
  )
  const activeSeries = useMemo(() => schedules.filter(s => s.active), [schedules])
  const completedVisits = visitStats?.completed ?? visitStats?.total ?? pastJobs.length
  const nextVisit = upcomingJobs[0]
  const recent = allActivity.slice(0, 7)

  const attentionCount = openQuotes.length + unpaidInvoices.length

  return (
    <div className="space-y-4 max-w-6xl">
      {/* Origin request tie-back — how this client came in (converted lead →
          its intake). The "everything links to the client" pairing to the
          RequestDetail page's linked-client card. */}
      {intakes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3 px-1">
          <Inbox className="w-3.5 h-3.5 shrink-0" />
          <span>Came in as</span>
          {intakes.slice(0, 3).map((r, i) => (
            <span key={r.id} className="inline-flex items-center gap-2">
              {i > 0 && <span className="text-ink-3/50">·</span>}
              <RecordLink type="request" id={r.id}
                label={`Request #${r.id}${r.source ? ` (${r.source})` : ''}`} />
            </span>
          ))}
        </div>
      )}

      {/* KPI strip */}
      <Card padded={false}>
        <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-y md:divide-y-0 divide-hairline">
          <StatCard label="Lifetime value" value={money(totalRevenue)} sub="paid to date"
            icon={DollarSign} accent="text-emerald-600" onClick={() => setTab('invoices')} />
          <StatCard label="Balance owed" value={money(outstanding)}
            sub={`${unpaidInvoices.length} unpaid`} icon={AlertCircle}
            accent={outstanding > 0 ? 'text-amber-600' : 'text-ink'} onClick={() => setTab('invoices')} />
          <StatCard label="Visits done" value={completedVisits} sub="completed"
            icon={CheckCircle2} onClick={() => setTab('jobs')} />
          <StatCard label="Next visit" value={nextVisit ? formatDateShort(nextVisit.scheduled_date) : '—'}
            sub={nextVisit ? (nextVisit.address || 'scheduled') : 'none scheduled'} icon={CalendarCheck}
            accent={nextVisit ? 'text-blue-600' : 'text-ink-3'} onClick={() => setTab('calendar')} />
          <StatCard label="Recurring" value={activeSeries.length}
            sub={activeSeries.length === 1 ? 'active series' : 'active series'} icon={Repeat}
            onClick={() => setTab('recurring')} />
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Needs attention */}
        <Card title="Needs attention" icon={AlertCircle} iconColor="text-amber-500"
          badge={attentionCount > 0
            ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">{attentionCount}</span>
            : null}
          className="lg:col-span-2" padded={false}>
          <div className="p-2">
            {attentionCount === 0 ? (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-ink-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" /> All caught up — no open quotes or unpaid invoices.
              </div>
            ) : (
              <div className="space-y-0.5">
                {openQuotes.map(q => (
                  <AttentionRow key={`q${q.id}`} icon={FileText} tone="text-indigo-500"
                    title={`Quote ${q.quote_number || ''} · ${money(q.total)}`.trim()}
                    meta={q.status === 'changes_requested' ? 'Customer requested changes' : q.viewed_at ? 'Opened — awaiting reply' : 'Sent — not opened yet'}
                    badge={q.viewed_at ? <Eye className="w-3.5 h-3.5 text-indigo-500 shrink-0" /> : null}
                    onClick={() => navigate(`/quotes/${q.id}`)} />
                ))}
                {unpaidInvoices.map(inv => (
                  <AttentionRow key={`i${inv.id}`} icon={Receipt}
                    tone={inv.status === 'overdue' ? 'text-rose-500' : 'text-emerald-500'}
                    title={`Invoice ${inv.invoice_number || ''} · ${money(inv.total)}`.trim()}
                    meta={inv.status === 'overdue' ? 'Overdue' : `Due ${inv.due_date ? formatDateShort(inv.due_date) : 'soon'}`}
                    onClick={() => navigate(`/invoices/${inv.id}`)} />
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Recent activity */}
        <Card title="Recent activity" icon={Clock}
          action={<button onClick={() => setTab('activity')} className="text-[11px] text-blue-500 hover:underline">View all</button>}
          padded={false}>
          <div className="p-2">
            {recent.length === 0 ? (
              <div className="px-3 py-6 text-sm text-ink-3">Nothing yet.</div>
            ) : (
              <ul className="space-y-0.5">
                {recent.map((item, i) => {
                  const line = activityLine(item)
                  const Icon = line.icon
                  return (
                    <li key={i} className="flex items-center gap-2.5 px-3 py-1.5">
                      <Icon className={`w-3.5 h-3.5 shrink-0 ${line.tone}`} />
                      <span className="text-[12px] text-ink-2 truncate flex-1">{line.text}</span>
                      <span className="text-[10px] text-ink-3 shrink-0 tabular-nums">
                        {item.date ? formatDateShort(item.date) : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Upcoming visits */}
        <Card title="Upcoming visits" icon={CalendarCheck}
          badge={upcomingJobs.length ? <span className="text-[10px] font-semibold text-ink-3">{upcomingJobs.length}</span> : null}
          action={<button onClick={() => setTab('calendar')} className="text-[11px] text-blue-500 hover:underline">Schedule</button>}
          className="lg:col-span-2" padded={false}>
          <div className="p-2">
            {upcomingJobs.length === 0 ? (
              <div className="px-3 py-6 text-sm text-ink-3">No upcoming visits scheduled.</div>
            ) : (
              <div className="space-y-0.5">
                {upcomingJobs.slice(0, 4).map(j => (
                  <AttentionRow key={j.id} icon={Briefcase} tone="text-blue-500"
                    title={`${formatDateShort(j.scheduled_date)} · ${j.title || 'Cleaning'}`}
                    meta={j.address || j.status}
                    onClick={() => navigate(`/jobs/${j.id}`)} />
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Properties + edit */}
        <Card title="Properties" icon={Home}
          action={<button onClick={() => setTab('properties')} className="text-[11px] text-blue-500 hover:underline">Manage</button>}
          padded={false}>
          <div className="p-2">
            {properties.length === 0 ? (
              <div className="px-3 py-6 text-sm text-ink-3">No properties on file.</div>
            ) : (
              <div className="space-y-0.5">
                {properties.slice(0, 3).map(p => (
                  <AttentionRow key={p.id} icon={Home} tone="text-ink-3"
                    title={p.name || p.address || 'Property'} meta={p.name ? p.address : p.property_type}
                    onClick={() => navigate(`/properties/${p.id}`)} />
                ))}
              </div>
            )}
            <button onClick={() => setTab('details')}
              className="w-full mt-1 flex items-center justify-center gap-1.5 text-[12px] text-ink-2 hover:text-ink py-2 border-t border-hairline">
              <Pencil className="w-3.5 h-3.5" /> Edit contact details
            </button>
          </div>
        </Card>
      </div>
    </div>
  )
}
