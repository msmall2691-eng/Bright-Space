/**
 * Home — a calm, record-forward command center in the Twenty-CRM style.
 *
 * Gone is the dark glowing hero: the page now opens on a light greeting bar
 * and a flat strip of stat tiles (hairline borders, whisper shadows, one
 * accent hue — never a wall of competing colors). Below that, three pillar
 * cards frame the work the business runs on, then a two-column working area
 * lays out the live lists: the "Needs you now" action feed, crew load, the
 * quote/lead funnel, today's route, a money read-out, and recent customer
 * confirmations. Everything is wired to the same dashboard data hooks;
 * deeper analytics still live on the Owner page.
 *
 * Design notes (Twenty CRM + dataviz skill):
 *   • Flat surfaces — `SOFT` is a plain panel + hairline + `shadow-glass-sm`,
 *     matching the shared `SOFT_CARD` token used by the imported tiles.
 *   • Stat tiles carry the number as the hero in calm ink; the label sits
 *     above, a single contextual line below. Color is reserved for status
 *     (overdue = amber), never decoration.
 *   • Magnitude bars are a single indigo hue with rounded ends, not a
 *     rainbow gradient.
 */
import { useNavigate } from 'react-router-dom'
import { ErrorState, Skeleton } from '../components/ui'
import {
  DollarSign, TrendingUp, Inbox, MessageSquare, CalendarDays,
  ArrowUpRight, Users, AlertTriangle, ArrowRight, MapPin,
} from 'lucide-react'
import { fmtMoney } from '../components/dashboard/utils'
import { NeedsYouNow } from '../components/dashboard/NeedsYouNow'
import { CustomerActivity } from '../components/dashboard/CustomerActivity'
import { QuotesLeadsTile } from '../components/dashboard/QuotesLeadsTile'
import { useDashboardData } from '../hooks/useDashboardData'
import { useDashboardDerived } from '../hooks/useDashboardDerived'

/** The flat Twenty-style card surface, kept in sync with the shared
 *  `SOFT_CARD` token (constants.js) the imported tiles use. */
const SOFT = 'bg-panel rounded-xl border border-hairline shadow-glass-sm'

/** Compact money for the tight stat tiles — keeps big totals from clipping:
 *  $24K · $840K · $1.9M. Full precision still shows in the Money tile. */
const fmtCompact = (n) => {
  const v = Math.round(n || 0)
  const a = Math.abs(v)
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1)}M`
  if (a >= 1e4) return `$${Math.round(v / 1e3)}K`
  return `$${v.toLocaleString()}`
}

/* ── Header ───────────────────────────────────────────────────────────── */

/** Light greeting bar with the day's status and quick-create actions.
 *  Ghost-bordered buttons in the Twenty idiom — calm, not shouting. */
function DashHeader({ greeting, longDate, todayCount, weekCount, loading, navigate }) {
  const quick = [
    { label: 'New lead', to: '/requests?new=1', icon: Inbox },
    { label: 'New message', to: '/comms?compose=1', icon: MessageSquare },
    { label: 'New job', to: '/schedule?new=1', icon: CalendarDays },
  ]
  const status = loading
    ? 'Loading your day…'
    : `${todayCount === 0 ? 'No jobs' : `${todayCount} ${todayCount === 1 ? 'job' : 'jobs'}`} today · ${weekCount} this week`
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-[12px] font-medium text-ink-3">{status}</span>
        </div>
        <h1 className="mt-1.5 text-2xl sm:text-3xl font-bold tracking-tight text-ink">{greeting}</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">{longDate}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {quick.map(q => (
          <button key={q.to} onClick={() => navigate(q.to)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] font-semibold text-ink-2 hover:bg-bg hover:text-ink transition-colors">
            <q.icon className="w-3.5 h-3.5 text-ink-3" /> {q.label}
          </button>
        ))}
      </div>
    </header>
  )
}

/* ── Stat tiles (KPI strip) ───────────────────────────────────────────── */

/** One flat stat tile. The number is the hero in calm ink; label above,
 *  a single contextual line below. `tone` recolors only the sub-line so
 *  color stays reserved for status (e.g. overdue), never decoration. */
function StatTile({ label, value, sub, subTone, icon: Icon, onClick, loading }) {
  return (
    <button onClick={onClick}
      className={`${SOFT} group text-left px-4 py-3.5 hover:border-hairline-2 transition-colors`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 truncate">{label}</span>
        <Icon className="w-4 h-4 text-ink-3/70 group-hover:text-indigo-500 transition-colors" />
      </div>
      {loading
        ? <div className="mt-2 h-7 w-20 rounded bg-bg-2 animate-pulse" />
        : <div className="mt-1.5 text-2xl font-bold text-ink tabular-nums leading-none truncate">{value}</div>}
      <div className={`mt-1.5 h-4 text-[11px] font-medium ${subTone || 'text-ink-3'} truncate`}>
        {loading ? '' : (sub || '')}
      </div>
    </button>
  )
}

function KpiStrip({ loading, navigate, todayRevenue, mtdRevenue, outstanding, pipeline, overdueInvoiceCount }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatTile label="Today" icon={DollarSign} loading={loading}
        value={fmtCompact(todayRevenue)} sub="collected today"
        onClick={() => navigate('/billing?view=invoices')} />
      <StatTile label="This month" icon={TrendingUp} loading={loading}
        value={fmtCompact(mtdRevenue)} sub="revenue"
        onClick={() => navigate('/owner')} />
      <StatTile label="Outstanding" icon={AlertTriangle} loading={loading}
        value={fmtCompact(outstanding)}
        sub={overdueInvoiceCount > 0 ? `${overdueInvoiceCount} overdue` : 'nothing overdue'}
        subTone={overdueInvoiceCount > 0 ? 'text-amber-600 dark:text-amber-300' : undefined}
        onClick={() => navigate('/billing?view=invoices&status=overdue')} />
      <StatTile label="Pipeline" icon={Inbox} loading={loading}
        value={fmtCompact(pipeline)} sub="open quotes"
        onClick={() => navigate('/billing?view=quotes')} />
    </div>
  )
}

/* ── Pillar cards ─────────────────────────────────────────────────────── */

// Calm ink numbers (Twenty-style) with a single small tinted icon chip per
// pillar so the tiles stay distinguishable without three competing hues.
const PILLAR = {
  indigo:  'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  blue:    'bg-blue-500/10 text-blue-600 dark:text-blue-300',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
}

function Pillar({ icon: Icon, accent, value, headline, label, urgent, stats, onClick, loading }) {
  return (
    <button onClick={onClick}
      className={`${SOFT} group text-left p-5 hover:border-hairline-2 transition-colors`}>
      <div className="flex items-start justify-between">
        <span className={`grid place-items-center w-10 h-10 rounded-xl ${PILLAR[accent]}`}>
          <Icon className="w-5 h-5" />
        </span>
        <span className="flex items-center gap-2">
          {urgent > 0 && (
            <span className="inline-flex items-center rounded-full bg-red-500/10 text-red-600 dark:text-red-300 px-2 py-0.5 text-[11px] font-semibold">{urgent} urgent</span>
          )}
          <ArrowUpRight className="w-4 h-4 text-ink-3 group-hover:text-indigo-500 transition-colors" />
        </span>
      </div>
      <div className="mt-4 flex items-end gap-2">
        {loading
          ? <Skeleton className="h-11 w-16" />
          : <span className="text-4xl font-bold tabular-nums leading-none text-ink">{value}</span>}
      </div>
      <div className="mt-2 text-sm font-semibold text-ink">{headline}</div>
      <div className="text-xs text-ink-3">{label}</div>
      {stats?.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline pt-3">
          {stats.map((s, i) => (
            <span key={i} className="text-[11px] text-ink-3">
              <span className={`font-bold tabular-nums ${s.tone || 'text-ink-2'}`}>{loading ? '—' : s.n}</span> {s.label}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

/* ── Local tiles ──────────────────────────────────────────────────────── */

function TileHead({ icon: Icon, tint, title, action, onAction }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-hairline">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={`grid place-items-center w-8 h-8 rounded-lg shrink-0 ${tint}`}><Icon className="w-4 h-4" /></span>
        <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
      </div>
      {action && (
        <button onClick={onAction} className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-0.5 shrink-0">
          {action} <ArrowRight className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

function TodayRoute({ loading, todayJobs, todayCount, navigate }) {
  return (
    <section className={`${SOFT} overflow-hidden`}>
      <TileHead icon={CalendarDays} tint="bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
        title={`Today's route${todayCount ? ` · ${todayCount}` : ''}`} action="Schedule" onAction={() => navigate('/schedule')} />
      {loading ? (
        <div className="p-4 space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : todayJobs.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-semibold text-ink">Nothing on the calendar</p>
          <p className="text-[12px] text-ink-3 mt-0.5">No jobs scheduled for today.</p>
        </div>
      ) : (
        <div className="divide-y divide-hairline max-h-[300px] overflow-y-auto">
          {todayJobs.slice(0, 6).map(j => (
            <button key={j.id} onClick={() => navigate(`/jobs/${j.id}`)}
              className="w-full text-left flex items-center gap-3 px-5 py-2.5 hover:bg-bg transition-colors">
              <span className="text-[12px] font-bold text-indigo-600 tabular-nums w-12 shrink-0">{(j.start_time || '').slice(0, 5) || '—'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{j.title || `Job #${j.id}`}</div>
                {j.property_name && (
                  <div className="text-[11px] text-ink-3 truncate inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{j.property_name}</div>
                )}
              </div>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${(j.cleaner_ids && j.cleaner_ids.length) ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-600 dark:text-amber-300'}`}>
                {(j.cleaner_ids && j.cleaner_ids.length) ? 'Assigned' : 'No crew'}
              </span>
            </button>
          ))}
          {todayJobs.length > 6 && (
            <button onClick={() => navigate('/schedule')} className="w-full px-5 py-2 text-[11px] text-ink-3 hover:text-indigo-600 text-left">
              +{todayJobs.length - 6} more · Open schedule →
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function MoneyRead({ loading, outstanding, pipeline, mtdRevenue, overdueInvoiceCount, navigate }) {
  const rows = [
    { label: 'Collected this month', value: fmtMoney(mtdRevenue), go: () => navigate('/owner') },
    { label: 'Outstanding', value: fmtMoney(outstanding), tone: overdueInvoiceCount > 0 ? 'text-amber-600 dark:text-amber-300' : undefined,
      sub: overdueInvoiceCount > 0 ? `${overdueInvoiceCount} overdue` : null, go: () => navigate('/billing?view=invoices') },
    { label: 'Open quotes', value: fmtMoney(pipeline), go: () => navigate('/billing?view=quotes') },
  ]
  return (
    <section className={`${SOFT} overflow-hidden`}>
      <TileHead icon={DollarSign} tint="bg-indigo-500/10 text-indigo-600 dark:text-indigo-300" title="Money" action="Details" onAction={() => navigate('/billing?view=invoices')} />
      <div className="divide-y divide-hairline">
        {rows.map((r, i) => (
          <button key={i} onClick={r.go} className="w-full flex items-center justify-between gap-3 px-5 py-3 hover:bg-bg transition-colors text-left">
            <span className="text-[13px] text-ink-2">{r.label}{r.sub && <span className="ml-2 text-[11px] font-semibold text-amber-600 dark:text-amber-300">{r.sub}</span>}</span>
            <span className={`text-base font-bold tabular-nums ${r.tone || 'text-ink'}`}>{loading ? '—' : r.value}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function CrewLoad({ loading, crew, navigate }) {
  const max = Math.max(1, ...crew.rows.map(r => r.n))
  return (
    <section className={`${SOFT} overflow-hidden`}>
      <TileHead icon={Users} tint="bg-violet-500/10 text-violet-600 dark:text-violet-300"
        title="Crew load · 7 days" action="Dispatch" onAction={() => navigate('/schedule?view=dispatch')} />
      {loading ? (
        <div className="p-4 space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-6 w-full" />)}</div>
      ) : crew.rows.length === 0 ? (
        <div className="px-5 py-8 text-center"><p className="text-sm font-semibold text-ink">No assignments yet</p><p className="text-[12px] text-ink-3 mt-0.5">Nothing scheduled this week.</p></div>
      ) : (
        <div className="px-5 py-4 space-y-2.5">
          {crew.rows.slice(0, 5).map(r => (
            <div key={r.id} className="flex items-center gap-3">
              <span className="text-[12px] text-ink-2 w-20 truncate shrink-0">{r.name}</span>
              <div className="flex-1 h-2 rounded-full bg-bg-2 overflow-hidden">
                {/* Single-hue magnitude bar with rounded end (dataviz): no rainbow gradient. */}
                <div className="h-full rounded-full bg-indigo-500" style={{ width: `${(r.n / max) * 100}%` }} />
              </div>
              <span className="text-[12px] font-bold tabular-nums text-ink w-6 text-right shrink-0">{r.n}</span>
            </div>
          ))}
          {crew.unassigned > 0 && (
            <button onClick={() => navigate('/schedule?view=dispatch')}
              className="w-full mt-1 flex items-center justify-between gap-2 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300 hover:opacity-90">
              <span>{crew.unassigned} job{crew.unassigned === 1 ? '' : 's'} with no crew</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const navigate = useNavigate()
  const {
    todayJobs: rawTodayJobs, weekJobs, invoices, followUps, todayVisits,
    overdueConvs, unassignedConvs,
    svcRevenue, commsSummary,
    employees, rosterUnavailable,
    summary, loading, error, reload, t,
  } = useDashboardData()

  const {
    todayRevenue, mtdRevenue, outstanding, pipeline, overdueInvoiceCount,
    quoteActions, attention, turnover, slaBreached, crew,
    todayJobs, todayCount, weekCount,
  } = useDashboardDerived({
    invoices, followUps, todayVisits, overdueConvs, unassignedConvs,
    commsSummary, employees, weekJobs, todayJobs: rawTodayJobs, summary, t, navigate,
  })

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const longDate = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  if (error && !loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <ErrorState title="Couldn't load your dashboard"
          description="The server didn't respond. Check your connection and try again." onRetry={reload} />
      </div>
    )
  }

  return (
    <div className="relative min-h-full">
      <div className="relative px-4 sm:px-6 pt-5 pb-8 max-w-[1440px] mx-auto space-y-5">

        <DashHeader
          greeting={greeting} longDate={longDate} todayCount={todayCount} weekCount={weekCount}
          loading={loading} navigate={navigate} />

        <KpiStrip
          loading={loading} navigate={navigate}
          todayRevenue={todayRevenue} mtdRevenue={mtdRevenue} outstanding={outstanding}
          pipeline={pipeline} overdueInvoiceCount={overdueInvoiceCount} />

        {/* Three pillars — the work the business runs on */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Pillar icon={Inbox} accent="indigo" loading={loading}
            value={quoteActions.newLeads}
            headline={quoteActions.newLeads === 1 ? 'new lead to quote' : 'new leads to quote'}
            label="Turn inquiries into booked work" urgent={quoteActions.newLeads}
            stats={[
              { n: quoteActions.followUp, label: 'to follow up', tone: quoteActions.followUp > 0 ? 'text-amber-600 dark:text-amber-300' : undefined },
              { n: quoteActions.awaiting, label: 'awaiting reply' },
            ]}
            onClick={() => navigate('/requests')} />
          <Pillar icon={MessageSquare} accent="blue" loading={loading}
            value={overdueConvs.length + unassignedConvs.length}
            headline={(overdueConvs.length + unassignedConvs.length) === 1 ? 'conversation needs a reply' : 'conversations need a reply'}
            label="Keep customers in the loop" urgent={slaBreached}
            stats={[
              { n: slaBreached, label: 'past SLA', tone: slaBreached > 0 ? 'text-red-600 dark:text-red-300' : undefined },
              { n: unassignedConvs.length, label: 'unassigned' },
            ]}
            onClick={() => navigate('/comms')} />
          <Pillar icon={CalendarDays} accent="emerald" loading={loading}
            value={todayCount}
            headline={todayCount === 1 ? 'job today' : 'jobs today'}
            label="Keep the crews on track" urgent={turnover.needCrew}
            stats={[
              { n: weekCount, label: 'this week' },
              { n: turnover.needCrew, label: 'need a crew', tone: turnover.needCrew > 0 ? 'text-amber-600 dark:text-amber-300' : undefined },
            ]}
            onClick={() => navigate('/schedule')} />
        </div>

        {/* Working area: a wide left column (the action feed + crew/funnel) and
            a narrower right rail (today's route, money, confirmations). */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          <div className="xl:col-span-2 space-y-4">
            <NeedsYouNow attention={attention} loading={loading} navigate={navigate} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              <CrewLoad loading={loading} crew={crew} navigate={navigate} />
              <QuotesLeadsTile loading={loading} quoteActions={quoteActions} navigate={navigate} />
            </div>
          </div>
          <div className="space-y-4">
            <TodayRoute loading={loading} todayJobs={todayJobs} todayCount={todayCount} navigate={navigate} />
            <MoneyRead loading={loading} outstanding={outstanding} pipeline={pipeline}
              mtdRevenue={mtdRevenue} overdueInvoiceCount={overdueInvoiceCount} navigate={navigate} />
            <CustomerActivity navigate={navigate} />
          </div>
        </div>
      </div>
    </div>
  )
}
