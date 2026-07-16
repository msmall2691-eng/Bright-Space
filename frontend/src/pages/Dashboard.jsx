/**
 * Dashboard — command center, action-first.
 *
 * Deliberately lean: a compact hero with the four numbers that matter as
 * inline pills, then ONE "Needs you now" list that merges every actionable
 * thing (reschedule approvals + overdue replies / late starts / unassigned /
 * past-due invoices), then Today's schedule, the quotes/leads worklist, and a
 * money snapshot. The old layout (4 big KPI cards + funnel + 8 tiles +
 * AI-followups) was a wall of widgets; this is what an owner actually opens
 * the app to see. Deeper analytics live on the Owner page.
 */
import { useNavigate } from 'react-router-dom'
import { ErrorState } from '../components/ui'
import { DollarSign, TrendingUp, Clock, FileText } from 'lucide-react'
import { fmtMoney } from '../components/dashboard/utils'
import { NeedsYouNow } from '../components/dashboard/NeedsYouNow'
import { TodayTile } from '../components/dashboard/TodayTile'
import { QuotesLeadsTile } from '../components/dashboard/QuotesLeadsTile'
import { MoneyTile } from '../components/dashboard/MoneyTile'
import { useDashboardData } from '../hooks/useDashboardData'
import { useDashboardDerived } from '../hooks/useDashboardDerived'

/** One headline number as an inline pill — replaces the old row of big KPI
 *  cards so the numbers read at a glance without eating half the screen. */
function MetricPill({ icon: Icon, label, value, tone, accent, onClick }) {
  return (
    <button onClick={onClick}
      className="group flex items-center gap-2.5 rounded-xl border border-hairline bg-panel px-3 py-2 hover:border-hairline-2 hover:shadow-sm transition-all text-left">
      <span className={`grid place-items-center w-8 h-8 rounded-lg shrink-0 ${tone}`}>
        <Icon className="w-4 h-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-3 leading-none">{label}</span>
        <span className={`block text-[15px] font-bold tabular-nums leading-tight mt-0.5 ${accent || 'text-ink'}`}>{value}</span>
      </span>
    </button>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const {
    todayJobs: rawTodayJobs, weekJobs, invoices, followUps, todayVisits,
    overdueConvs, unassignedConvs,
    svcRevenue, commsSummary,
    employees, rosterUnavailable,
    summary,
    loading, error,
    reload,
    t,
  } = useDashboardData()

  const {
    todayRevenue, mtdRevenue, outstanding, pipeline, overdueInvoiceCount,
    quoteActions,
    arAging,
    attention,
    todayJobs, todayCount, weekCount,
  } = useDashboardDerived({
    invoices, followUps, todayVisits,
    overdueConvs, unassignedConvs,
    commsSummary, employees,
    weekJobs, todayJobs: rawTodayJobs,
    summary,
    t,
    navigate,
  })

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const longDate = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const dash = (v) => loading ? '—' : v

  if (error && !loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <ErrorState
          title="Couldn't load your dashboard"
          description="The server didn't respond. Check your connection and try again."
          onRetry={reload}
        />
      </div>
    )
  }

  return (
    <div className="bg-bg">
      <div className="px-4 sm:px-6 pt-3 pb-5 max-w-[1400px] mx-auto space-y-3.5">

        {/* Hero: greeting + the four numbers that matter, as compact pills */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-ink tracking-tight leading-tight">{greeting} 👋</h1>
            <p className="text-xs sm:text-[13px] text-ink-3 mt-0.5">
              {longDate}
              {loading ? ' · loading…' : (
                <>{' · '}{todayCount === 0 ? 'no jobs today' : `${todayCount} today`}{` · ${weekCount} this week`}</>
              )}
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:flex gap-2">
            <MetricPill icon={DollarSign} label="Today" value={dash(fmtMoney(todayRevenue))}
              tone="bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
              onClick={() => navigate('/billing?view=invoices')} />
            <MetricPill icon={TrendingUp} label="This month" value={dash(fmtMoney(mtdRevenue))}
              tone="bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300"
              onClick={() => navigate('/owner')} />
            <MetricPill icon={Clock} label="Outstanding" value={dash(fmtMoney(outstanding))}
              tone="bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300"
              accent={!loading && overdueInvoiceCount > 0 ? 'text-amber-600 dark:text-amber-300' : undefined}
              onClick={() => navigate('/billing?view=invoices&status=overdue')} />
            <MetricPill icon={FileText} label="Pipeline" value={dash(fmtMoney(pipeline))}
              tone="bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300"
              onClick={() => navigate('/billing?view=quotes')} />
          </div>
        </div>

        {/* The star: everything that needs the owner, in one list */}
        <NeedsYouNow attention={attention} loading={loading} navigate={navigate} />

        {/* Today + quotes/leads worklist */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-start">
          <TodayTile loading={loading} todayJobs={todayJobs} todayCount={todayCount}
            weekCount={weekCount} navigate={navigate} />
          <QuotesLeadsTile loading={loading} quoteActions={quoteActions} navigate={navigate} />
        </div>

        {/* Money snapshot — the detail behind the pills (AR aging, by service) */}
        <MoneyTile
          todayRevenue={todayRevenue} mtdRevenue={mtdRevenue} outstanding={outstanding}
          pipeline={pipeline} invoices={invoices} overdueInvoiceCount={overdueInvoiceCount}
          summary={summary} arAging={arAging} svcRevenue={svcRevenue} navigate={navigate} />

      </div>
    </div>
  )
}
