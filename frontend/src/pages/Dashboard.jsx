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
import { useNavigate } from 'react-router-dom'
import { ErrorState } from '../components/ui'
import { AIFollowUps } from '../components/AIFollowUps'
import {
  Calendar, DollarSign,
  Clock, FileText, TrendingUp, LayoutDashboard,
} from 'lucide-react'
import { fmtMoney } from '../components/dashboard/utils'
import { KpiCard } from '../components/dashboard/primitives'
import { Funnel } from '../components/dashboard/Funnel'
import { InboxTile } from '../components/dashboard/InboxTile'
import { TodayTile } from '../components/dashboard/TodayTile'
import { QuotesLeadsTile } from '../components/dashboard/QuotesLeadsTile'
import { TurnoverCoverageTile, CrewWorkloadTile } from '../components/dashboard/OperationsTiles'
import { MoneyTile } from '../components/dashboard/MoneyTile'
import { RescheduleRequestsTile } from '../components/dashboard/RescheduleRequestsTile'
import { useDashboardData } from '../hooks/useDashboardData'
import { useDashboardDerived } from '../hooks/useDashboardDerived'

/* ── Page ─────────────────────────────────────────────────────────── */
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
  const activeClients = summary?.active_clients ?? null

  const {
    todayRevenue, mtdRevenue, outstanding, pipeline, overdueInvoiceCount,
    quoteActions,
    funnel,
    turnover,
    slaBreached,
    crew,
    arAging,
    attention,
    hiddenOverdueConvs, hiddenUnassignedConvs, hiddenInvoices, hiddenLateVisits,
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
      <div className="px-4 sm:px-6 pt-6 pb-3 flex items-center gap-3">
        <span className="bb-icon-chip hidden sm:grid place-items-center w-11 h-11 rounded-xl shrink-0 bg-blue-50 text-blue-600">
          <LayoutDashboard className="w-5 h-5" />
        </span>
        <div className="min-w-0">
        <h1 className="text-2xl sm:text-[28px] font-bold text-ink tracking-tight">{greeting} 👋</h1>
        <p className="text-sm text-ink-3 mt-1">
          {longDate}
          {loading ? ' · loading…' : (
            <>
              {' · '}
              {todayCount === 0 ? 'no jobs today' : `${todayCount} job${todayCount > 1 ? 's' : ''} today`}
              {` · ${weekCount} this week`}
              {attention.length > 0 && ` · ${attention.length} need attention`}
            </>
          )}
        </p>
        </div>
      </div>

      {/* KPI row — headline numbers, dashboard-style */}
      <div className="px-4 sm:px-6 grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard icon={DollarSign} chip="bg-emerald-50 text-emerald-600" label="Collected today"
          value={loading ? '—' : fmtMoney(todayRevenue)}
          sub={loading ? 'Loading…' : (todayRevenue > 0 ? 'paid today' : 'nothing yet today')} />
        <KpiCard icon={TrendingUp} chip="bg-blue-50 text-blue-600" label="Month to date"
          value={loading ? '—' : fmtMoney(mtdRevenue)} sub={loading ? 'Loading…' : `${paidCount} paid`} />
        <KpiCard icon={Clock} chip="bg-amber-50 text-amber-600" label="Outstanding"
          value={loading ? '—' : fmtMoney(outstanding)}
          sub={loading ? 'Loading…' : `${unpaidCount} unpaid${overdueInvoiceCount ? ` · ${overdueInvoiceCount} overdue` : ''}`}
          accent={!loading && overdueInvoiceCount > 0 ? 'text-amber-600' : undefined} />
        <KpiCard icon={FileText} chip="bg-violet-50 text-violet-600" label="Quote pipeline"
          value={loading ? '—' : fmtMoney(pipeline)} sub={loading ? 'Loading…' : `${summary?.quotes?.sent ?? 0} sent`}
          accent="text-violet-700" />
      </div>

      {/* Lead → client funnel — the conversion pipeline at a glance */}
      <div className="px-4 sm:px-6 pt-4">
        <Funnel stages={funnel.stages} convRate={funnel.convRate} activeClients={activeClients} loading={loading} />
      </div>

      {/* Tiles grid */}
      <div className="px-4 sm:px-6 pt-4 pb-8 grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">

        {/* Customer reschedule requests — approve/decline inline. Hides when empty. */}
        <RescheduleRequestsTile navigate={navigate} />

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

        <QuotesLeadsTile
          loading={loading}
          quoteActions={quoteActions}
          navigate={navigate}
        />

        <TurnoverCoverageTile loading={loading} turnover={turnover} navigate={navigate} />
        <CrewWorkloadTile loading={loading} crew={crew} rosterUnavailable={rosterUnavailable} navigate={navigate} />

        <div className="lg:col-span-2">
          <MoneyTile
            todayRevenue={todayRevenue}
            mtdRevenue={mtdRevenue}
            outstanding={outstanding}
            pipeline={pipeline}
            invoices={invoices}
            overdueInvoiceCount={overdueInvoiceCount}
            summary={summary}
            arAging={arAging}
            svcRevenue={svcRevenue}
            navigate={navigate}
          />
        </div>

        {/* AI-computed operational follow-ups — auto-loads, hides when all clear */}
        <AIFollowUps title="Operations check" className="lg:col-span-2" />

      </div>
    </div>
  )
}
