/**
 * Home — a command-cockpit, not a wall of cards.
 *
 * A dramatic dark hero band carries the greeting + the money that matters as
 * glowing metric pods, then an asymmetric BENTO GRID lays out the live work:
 * three bold pillar pods (leads / messages / schedule), the "Needs you now"
 * action stream, today's route, a money read-out, crew load, the quote
 * funnel, and recent customer confirmations. Everything is wired to the same
 * dashboard data hooks; deeper analytics still live on the Owner page.
 */
import { useNavigate } from 'react-router-dom'
import { ErrorState, Skeleton } from '../components/ui'
import {
  DollarSign, TrendingUp, Inbox, MessageSquare, CalendarDays,
  ArrowUpRight, Users, Sparkles, AlertTriangle, ArrowRight, MapPin,
} from 'lucide-react'
import { fmtMoney } from '../components/dashboard/utils'
import { NeedsYouNow } from '../components/dashboard/NeedsYouNow'
import { CustomerActivity } from '../components/dashboard/CustomerActivity'
import { QuotesLeadsTile } from '../components/dashboard/QuotesLeadsTile'
import { useDashboardData } from '../hooks/useDashboardData'
import { useDashboardDerived } from '../hooks/useDashboardDerived'

const SOFT = 'bb-surface rounded-3xl border border-hairline bg-panel'

/** Compact money for the tight hero pods — keeps big totals from clipping:
 *  $24K · $840K · $1.9M. Full precision still shows in the Money tile. */
const fmtCompact = (n) => {
  const v = Math.round(n || 0)
  const a = Math.abs(v)
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1)}M`
  if (a >= 1e4) return `$${Math.round(v / 1e3)}K`
  return `$${v.toLocaleString()}`
}

/* ── Hero cockpit ─────────────────────────────────────────────────────── */

/** One glowing metric inside the dark hero band. */
function Pod({ label, value, delta, deltaTone, onClick, loading }) {
  return (
    <button onClick={onClick}
      className="group text-left rounded-2xl bg-white/[0.06] hover:bg-white/[0.10] backdrop-blur border border-white/10 px-4 py-3 transition-colors">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-200/70">{label}</div>
      {loading
        ? <div className="mt-1.5 h-7 w-20 rounded bg-white/10 animate-pulse" />
        : <div className="mt-1 text-xl sm:text-2xl font-bold text-white tabular-nums leading-none truncate">{value}</div>}
      {delta && (
        <div className={`mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium ${deltaTone || 'text-indigo-200/70'}`}>
          {delta}
        </div>
      )}
    </button>
  )
}

function HeroCockpit({ greeting, longDate, todayCount, weekCount, loading, navigate,
  todayRevenue, mtdRevenue, outstanding, pipeline, overdueInvoiceCount }) {
  const dash = (v) => loading ? '—' : v
  const quick = [
    { label: 'New lead', to: '/requests?new=1', icon: Inbox },
    { label: 'New message', to: '/comms?compose=1', icon: MessageSquare },
    { label: 'New job', to: '/schedule?new=1', icon: CalendarDays },
  ]
  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 px-5 py-6 sm:px-8 sm:py-7">
      {/* Decorative glows */}
      <span className="pointer-events-none absolute -top-24 -left-16 w-80 h-80 rounded-full bg-indigo-500/25 blur-3xl" />
      <span className="pointer-events-none absolute -bottom-28 right-10 w-96 h-96 rounded-full bg-fuchsia-500/15 blur-3xl" />
      <span className="pointer-events-none absolute top-10 right-1/3 w-72 h-72 rounded-full bg-violet-500/15 blur-3xl" />

      <div className="relative flex flex-col xl:flex-row xl:items-end xl:justify-between gap-6">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 border border-white/10 px-2.5 py-1 text-[11px] font-medium text-indigo-100/90">
            <Sparkles className="w-3 h-3" /> {loading ? 'Loading your day…' : `${todayCount === 0 ? 'No jobs' : `${todayCount} ${todayCount === 1 ? 'job' : 'jobs'}`} today · ${weekCount} this week`}
          </div>
          <h1 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-white">
            {greeting}
          </h1>
          <p className="mt-1 text-sm text-indigo-200/70">{longDate}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            {quick.map(q => (
              <button key={q.to} onClick={() => navigate(q.to)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors">
                <q.icon className="w-3.5 h-3.5" /> {q.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 xl:w-[540px] shrink-0">
          <Pod label="Today" value={dash(fmtCompact(todayRevenue))} loading={loading}
            onClick={() => navigate('/billing?view=invoices')} />
          <Pod label="This month" value={dash(fmtCompact(mtdRevenue))} loading={loading}
            delta={<><TrendingUp className="w-3 h-3" /> revenue</>} onClick={() => navigate('/owner')} />
          <Pod label="Outstanding" value={dash(fmtCompact(outstanding))} loading={loading}
            delta={!loading && overdueInvoiceCount > 0 ? <><AlertTriangle className="w-3 h-3" /> {overdueInvoiceCount} overdue</> : null}
            deltaTone="text-amber-300"
            onClick={() => navigate('/billing?view=invoices&status=overdue')} />
          <Pod label="Pipeline" value={dash(fmtCompact(pipeline))} loading={loading}
            onClick={() => navigate('/billing?view=quotes')} />
        </div>
      </div>
    </section>
  )
}

/* ── Bento pillar pods ────────────────────────────────────────────────── */

const PILLAR = {
  indigo:  { chip: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',   glow: 'bg-indigo-400/25',  n: 'text-indigo-600 dark:text-indigo-300' },
  blue:    { chip: 'bg-blue-500/15 text-blue-600 dark:text-blue-300',         glow: 'bg-blue-400/25',    n: 'text-blue-600 dark:text-blue-300' },
  emerald: { chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300', glow: 'bg-emerald-400/25', n: 'text-emerald-600 dark:text-emerald-300' },
}

function Pillar({ icon: Icon, accent, value, headline, label, urgent, stats, onClick, loading }) {
  const A = PILLAR[accent]
  return (
    <button onClick={onClick}
      className={`group relative overflow-hidden text-left ${SOFT} p-5 transition-all hover:-translate-y-0.5`}>
      <span className={`pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl opacity-70 ${A.glow}`} />
      <div className="relative flex items-start justify-between">
        <span className={`grid place-items-center w-11 h-11 rounded-2xl ${A.chip}`}>
          <Icon className="w-5 h-5" />
        </span>
        <span className="flex items-center gap-2">
          {urgent > 0 && (
            <span className="inline-flex items-center rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">{urgent} urgent</span>
          )}
          <ArrowUpRight className="w-5 h-5 text-ink-3 group-hover:text-ink transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </div>
      <div className="relative mt-4 flex items-end gap-2">
        {loading
          ? <Skeleton className="h-12 w-20" />
          : <span className={`text-5xl font-bold tabular-nums leading-none ${A.n}`}>{value}</span>}
      </div>
      <div className="relative mt-2 text-sm font-semibold text-ink">{headline}</div>
      <div className="relative text-xs text-ink-3">{label}</div>
      {stats?.length > 0 && (
        <div className="relative mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline pt-3">
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

/* ── Bento tiles ──────────────────────────────────────────────────────── */

function TileHead({ icon: Icon, tint, title, action, onAction }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-hairline">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={`grid place-items-center w-8 h-8 rounded-xl shrink-0 ${tint}`}><Icon className="w-4 h-4" /></span>
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
      <TileHead icon={CalendarDays} tint="bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
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
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${(j.cleaner_ids && j.cleaner_ids.length) ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-600 dark:text-amber-300'}`}>
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
    { label: 'Open pipeline', value: fmtMoney(pipeline), go: () => navigate('/billing?view=quotes') },
  ]
  return (
    <section className={`${SOFT} overflow-hidden`}>
      <TileHead icon={DollarSign} tint="bg-indigo-500/15 text-indigo-600 dark:text-indigo-300" title="Money" action="Details" onAction={() => navigate('/billing?view=invoices')} />
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
      <TileHead icon={Users} tint="bg-violet-500/15 text-violet-600 dark:text-violet-300"
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
                <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${(r.n / max) * 100}%` }} />
              </div>
              <span className="text-[12px] font-bold tabular-nums text-ink w-6 text-right shrink-0">{r.n}</span>
            </div>
          ))}
          {crew.unassigned > 0 && (
            <button onClick={() => navigate('/schedule?view=dispatch')}
              className="w-full mt-1 flex items-center justify-between gap-2 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300 hover:opacity-90">
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
      {/* Soft canvas glow so the page reads as a designed surface, not a form. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-indigo-500/[0.06] to-transparent" />
      <div className="relative px-4 sm:px-6 pt-4 pb-8 max-w-[1440px] mx-auto space-y-4">

        <HeroCockpit
          greeting={greeting} longDate={longDate} todayCount={todayCount} weekCount={weekCount}
          loading={loading} navigate={navigate}
          todayRevenue={todayRevenue} mtdRevenue={mtdRevenue} outstanding={outstanding}
          pipeline={pipeline} overdueInvoiceCount={overdueInvoiceCount} />

        {/* Three pillars — the work the business runs on */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

        {/* Bento: a wide left column (the action stream + crew/funnel) and a
            narrower right rail (today's route, money, confirmations). Balanced
            so neither side leaves a big empty gap. */}
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
