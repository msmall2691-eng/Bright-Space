/**
 * OwnerDashboard — the numbers Meg actually steers by (audit §1), extended
 * with the analytics widgets she asked for ("more just analytics… but hate
 * the typical SaaS bubbles").
 *
 * Data comes from several independent, read-only GETs — each widget renders
 * as soon as its own fetch lands, and a failed widget degrades to a quiet
 * "couldn't load" line instead of taking the page down:
 *   /api/dashboard/owner              close rate, MRR, AR aging, revenue mix
 *   /api/dashboard/property-economics "am I making money on this house"
 *   /api/dashboard/week-capacity      booked vs available crew hours
 *   /api/payroll/summary (Mon–Sun)    crew hours this week (native clock)
 *   /api/jobs/sync-overview           per-feed turnover feed health
 *   /api/recurring/cleanup/health     Recurring Doctor rollup
 *
 * Not linked from the main Dashboard on purpose — this is an owner tool,
 * not a daily-operations tile. Sidebar entry gates on admin/manager via
 * the Sidebar's badges (the backend also 403s viewers on /owner and the
 * financial widgets).
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  TrendingUp, DollarSign, Repeat, AlertTriangle, PieChart, Users, Building2,
} from 'lucide-react'
import { get } from '../api'
import { toLocalYMD } from '../utils/format'
import { fmtMoney } from '../components/dashboard/utils'
import { KpiCard, Tile, TileLoading, BarTip } from '../components/dashboard/primitives'
import { PropertyEconomicsTile } from '../components/dashboard/PropertyEconomicsTile'
import { WeekCapacityTile } from '../components/dashboard/WeekCapacityTile'
import { CrewHoursTile } from '../components/dashboard/CrewHoursTile'
import { FeedHealthTile } from '../components/dashboard/FeedHealthTile'
import { RecurringHealthTile } from '../components/dashboard/RecurringHealthTile'
import { ErrorState, PageHeader } from '../components/ui'

// Human-facing labels for the API's job_type values. The backend returns
// whatever's on Job.job_type, so unknowns fall through to a Start-Cased
// version of the raw key.
const SERVICE_LABELS = {
  residential: 'Residential',
  commercial: 'Commercial',
  str_turnover: 'STR turnover',
  unknown: 'Unclassified',
}

// status maps each aging bucket to the invoice-list filter it opens — the
// same mapping the classic dashboard's ArAgingTile uses (past-due buckets →
// overdue, current → sent).
const AGING_ORDER = [
  { key: '0_30',    label: '0–30 days',  tone: 'text-amber-600 dark:text-amber-300', status: 'overdue' },
  { key: '31_60',   label: '31–60 days', tone: 'text-orange-600 dark:text-orange-300', status: 'overdue' },
  { key: '61_90',   label: '61–90 days', tone: 'text-red-600 dark:text-red-300', status: 'overdue' },
  { key: '90_plus', label: '90+ days',   tone: 'text-red-700 dark:text-red-300 font-bold', status: 'overdue' },
]

function serviceLabel(key) {
  if (SERVICE_LABELS[key]) return SERVICE_LABELS[key]
  return String(key || 'Unknown')
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** One independent GET per widget: {data, loading, error}. */
function useGet(url) {
  const [state, setState] = useState({ data: null, loading: true, error: false })
  useEffect(() => {
    let cancelled = false
    setState({ data: null, loading: true, error: false })
    get(url)
      .then(data => { if (!cancelled) setState({ data, loading: false, error: false }) })
      .catch(() => { if (!cancelled) setState({ data: null, loading: false, error: true }) })
    return () => { cancelled = true }
  }, [url])
  return state
}

/** Mon–Sun of the current local week, as YYYY-MM-DD — matches the backend's
 *  Monday-anchored capacity week and the payroll page's pay week. */
function currentWeekRange() {
  const now = new Date()
  const mon = new Date(now)
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  return { start: toLocalYMD(mon), end: toLocalYMD(sun) }
}

export default function OwnerDashboard() {
  const navigate = useNavigate()
  const week = currentWeekRange()

  const owner = useGet('/api/dashboard/owner')
  const economics = useGet('/api/dashboard/property-economics')
  const capacity = useGet('/api/dashboard/week-capacity')
  const crewHours = useGet(`/api/payroll/summary?start_date=${week.start}&end_date=${week.end}`)
  const syncOverview = useGet('/api/jobs/sync-overview')
  const recurringHealth = useGet('/api/recurring/cleanup/health')

  if (owner.error) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl mx-auto">
        <ErrorState
          title="Could not load Owner Dashboard"
          description="Check your connection and try again."
          onRetry={() => window.location.reload()} />
      </div>
    )
  }

  const { data, loading } = owner
  const closeRate = data?.close_rate
  const mrr = data?.mrr
  const arAging = data?.ar_aging || {}
  const revenueByService = data?.revenue_by_service || []
  const topClients = data?.top_clients || []

  const arTotal = AGING_ORDER.reduce((sum, b) => sum + (arAging[b.key]?.total || 0), 0)
  const revenueTotal = revenueByService.reduce((sum, r) => sum + (r.total || 0), 0)

  const goInvoices = (status) =>
    navigate(`/billing?view=invoices${status ? `&status=${status}` : ''}`)

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <PageHeader
        title="Owner Dashboard"
        subtitle={`Close rate, MRR, and revenue for the trailing ${data?.window_days || 90} days${data?.as_of ? ` · as of ${data.as_of}` : ''}`}
        icon={TrendingUp}
        iconColor="emerald"
      />

      <div className="px-4 sm:px-6 pb-6 space-y-5">

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          icon={TrendingUp}
          chip="bg-bg-2 text-ink-2"
          label="Close rate (90d)"
          value={loading ? '—' : closeRate?.rate_pct != null ? `${closeRate.rate_pct}%` : 'n/a'}
          sub={loading ? 'Loading…' : closeRate
            ? `${closeRate.quotes_won} of ${closeRate.quotes_sent} sent`
            : null}
        />
        <KpiCard
          icon={Repeat}
          chip="bg-bg-2 text-ink-2"
          label="MRR estimate"
          value={loading ? '—' : fmtMoney((mrr?.estimate_cents || 0) / 100)}
          sub={loading ? 'Loading…' : mrr
            ? `${mrr.schedules_priced} priced${mrr.schedules_unpriced ? ` · ${mrr.schedules_unpriced} unpriced` : ''}`
            : null}
        />
        <KpiCard
          icon={DollarSign}
          chip="bg-bg-2 text-ink-2"
          label="Revenue paid (90d)"
          value={loading ? '—' : fmtMoney(revenueTotal)}
          sub={loading ? 'Loading…' : `${revenueByService.reduce((n, r) => n + (r.invoice_count || 0), 0)} invoices`}
        />
      </div>

      {/* "Am I making money on this house" — full width, it's the table */}
      <PropertyEconomicsTile {...economics} navigate={navigate} />

      <div className="grid grid-cols-1 shell:grid-cols-2 gap-5">
        {/* This week: how packed, and who's been on the clock */}
        <WeekCapacityTile {...capacity} navigate={navigate} />
        <CrewHoursTile {...crewHours} navigate={navigate} />

        {/* AR aging — every bucket links to the matching invoice list */}
        <Tile icon={AlertTriangle} iconColor="rose" title={`AR aging · ${fmtMoney(arTotal)} past due`}>
          {loading ? <TileLoading /> : (
            <div className="px-5 py-4 space-y-1">
              {AGING_ORDER.map(b => {
                const bucket = arAging[b.key] || { count: 0, total: 0 }
                const empty = !bucket.count
                return (
                  <button key={b.key} disabled={empty}
                    onClick={() => goInvoices(b.status)}
                    className={`w-full flex items-center justify-between rounded-md px-1.5 py-1.5 -mx-1.5 text-left transition-colors ${
                      empty ? 'cursor-default' : 'hover:bg-bg'}`}>
                    <span className="text-sm text-ink-2">{b.label}</span>
                    <span className="flex items-baseline gap-2">
                      <span className={`text-sm tabular-nums ${b.tone}`}>{fmtMoney(bucket.total)}</span>
                      <span className="text-[11px] text-ink-3 tabular-nums w-10 text-right">
                        {bucket.count} {bucket.count === 1 ? 'invoice' : 'invoices'}
                      </span>
                    </span>
                  </button>
                )
              })}
              {/* Not-yet-due receivables are healthy money; keep them visible
                  but visually separated from the past-due buckets above.
                  Only `unbucketed` (missing/malformed due_date) is flagged
                  as a data-quality issue. */}
              {arAging.current?.count > 0 && (
                <button onClick={() => goInvoices('sent')}
                  className="w-full mt-1 pt-2 border-t border-hairline flex items-center justify-between rounded-md px-1.5 py-1.5 -mx-1.5 text-left transition-colors hover:bg-bg">
                  <span className="text-sm text-ink-2">Current (not yet due)</span>
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm tabular-nums text-ink-2">{fmtMoney(arAging.current.total)}</span>
                    <span className="text-[11px] text-ink-3 tabular-nums w-10 text-right">
                      {arAging.current.count} {arAging.current.count === 1 ? 'invoice' : 'invoices'}
                    </span>
                  </span>
                </button>
              )}
              {arAging.unbucketed?.count > 0 && (
                <div className="pt-2 mt-2 border-t border-hairline flex items-center justify-between text-[11px] text-ink-3">
                  <span>Missing due date</span>
                  <span className="tabular-nums">{arAging.unbucketed.count} · {fmtMoney(arAging.unbucketed.total)}</span>
                </div>
              )}
            </div>
          )}
        </Tile>

        {/* Revenue by service */}
        <Tile icon={PieChart} iconColor="violet" title="Revenue by service (90d)">
          {loading ? <TileLoading /> : revenueByService.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-ink-3">
              No paid invoices in the window yet.
            </div>
          ) : (
            <div className="px-5 py-4 space-y-3">
              {revenueByService.map(r => {
                const pct = revenueTotal > 0 ? Math.round((r.total / revenueTotal) * 100) : 0
                return (
                  <div key={r.service_type}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-ink-2">{serviceLabel(r.service_type)}</span>
                      <span className="text-sm tabular-nums text-ink">
                        {fmtMoney(r.total)} <span className="text-[11px] text-ink-3">· {pct}%</span>
                      </span>
                    </div>
                    <BarTip value={fmtMoney(r.total)} label={`· ${pct}% of paid revenue`} className="w-full">
                      <div className="w-full h-1.5 bg-bg-2 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </BarTip>
                  </div>
                )
              })}
            </div>
          )}
        </Tile>

        {/* System health: turnover feeds + recurring series */}
        <FeedHealthTile {...syncOverview} navigate={navigate} />
        <RecurringHealthTile {...recurringHealth} navigate={navigate} />
      </div>

      {/* Top clients */}
      <Tile icon={Users} iconColor="blue" title="Top clients by paid revenue (90d)">
        {loading ? <TileLoading /> : topClients.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-3">
            No client revenue in the window yet.
          </div>
        ) : (
          <div className="divide-y divide-hairline">
            {topClients.map((c, i) => (
              <a key={c.client_id} href={`/clients/${c.client_id}`}
                 className="flex items-center gap-3 px-5 py-3 hover:bg-bg-2/60 transition-colors">
                <span className="grid place-items-center w-6 h-6 rounded-full bg-bg-2 text-[11px] font-semibold text-ink-3 tabular-nums shrink-0">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-ink truncate">
                    <Building2 className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                    <span className="truncate">{c.client_name}</span>
                  </div>
                  <div className="text-[11px] text-ink-3">
                    {c.invoice_count} {c.invoice_count === 1 ? 'invoice' : 'invoices'}
                  </div>
                </div>
                <div className="text-sm font-semibold text-ink tabular-nums">{fmtMoney(c.total)}</div>
              </a>
            ))}
          </div>
        )}
      </Tile>
      </div>
    </div>
  )
}
