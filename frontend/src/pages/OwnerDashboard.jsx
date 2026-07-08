/**
 * OwnerDashboard — the numbers Meg actually steers by (audit §1).
 *
 * Consumes GET /api/dashboard/owner. The endpoint returns pre-computed
 * aggregates so this page is presentation-only: KPI tiles across the top
 * (close rate, MRR, 90d revenue), then AR aging, revenue-by-service, and
 * top clients.
 *
 * Not linked from the main Dashboard on purpose — this is an owner tool,
 * not a daily-operations tile. Sidebar entry gates on admin/manager via
 * the Sidebar's badges (the backend also 403s viewers).
 */
import { useEffect, useState } from 'react'
import {
  TrendingUp, DollarSign, Repeat, AlertTriangle, PieChart, Users,
} from 'lucide-react'
import { get } from '../api'
import { fmtMoney } from '../components/dashboard/utils'
import { KpiCard, Tile, TileLoading } from '../components/dashboard/primitives'
import { ErrorState } from '../components/ui'

// Human-facing labels for the API's job_type values. The backend returns
// whatever's on Job.job_type, so unknowns fall through to a Start-Cased
// version of the raw key.
const SERVICE_LABELS = {
  residential: 'Residential',
  commercial: 'Commercial',
  str_turnover: 'STR turnover',
  unknown: 'Unclassified',
}

const AGING_ORDER = [
  { key: '0_30',    label: '0–30 days',  tone: 'text-amber-600' },
  { key: '31_60',   label: '31–60 days', tone: 'text-orange-600' },
  { key: '61_90',   label: '61–90 days', tone: 'text-red-600' },
  { key: '90_plus', label: '90+ days',   tone: 'text-red-700 font-bold' },
]

function serviceLabel(key) {
  if (SERVICE_LABELS[key]) return SERVICE_LABELS[key]
  return String(key || 'Unknown')
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export default function OwnerDashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    get('/api/dashboard/owner')
      .then(res => { if (!cancelled) { setData(res); setLoading(false) } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl mx-auto">
        <ErrorState
          title="Could not load Owner Dashboard"
          description="Check your connection and try again."
          onRetry={() => window.location.reload()} />
      </div>
    )
  }

  const closeRate = data?.close_rate
  const mrr = data?.mrr
  const arAging = data?.ar_aging || {}
  const revenueByService = data?.revenue_by_service || []
  const topClients = data?.top_clients || []

  const arTotal = AGING_ORDER.reduce((sum, b) => sum + (arAging[b.key]?.total || 0), 0)
  const revenueTotal = revenueByService.reduce((sum, r) => sum + (r.total || 0), 0)

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-ink tracking-tight">Owner Dashboard</h1>
        <p className="text-sm text-ink-3 mt-1">
          Rolling {data?.window_days || 90}-day metrics
          {data?.as_of && <> · as of {data.as_of}</>}
        </p>
      </header>

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          icon={TrendingUp}
          chip="bg-blue-50 text-blue-600"
          label="Close rate (90d)"
          value={loading ? '—' : closeRate?.rate_pct != null ? `${closeRate.rate_pct}%` : 'n/a'}
          sub={loading ? 'Loading…' : closeRate
            ? `${closeRate.quotes_won} of ${closeRate.quotes_sent} sent`
            : null}
        />
        <KpiCard
          icon={Repeat}
          chip="bg-emerald-50 text-emerald-600"
          label="MRR estimate"
          value={loading ? '—' : fmtMoney((mrr?.estimate_cents || 0) / 100)}
          sub={loading ? 'Loading…' : mrr
            ? `${mrr.schedules_priced} priced${mrr.schedules_unpriced ? ` · ${mrr.schedules_unpriced} unpriced` : ''}`
            : null}
        />
        <KpiCard
          icon={DollarSign}
          chip="bg-violet-50 text-violet-600"
          label="Revenue paid (90d)"
          value={loading ? '—' : fmtMoney(revenueTotal)}
          sub={loading ? 'Loading…' : `${revenueByService.reduce((n, r) => n + (r.invoice_count || 0), 0)} invoices`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* AR aging */}
        <Tile icon={AlertTriangle} iconColor="rose" title={`AR aging · ${fmtMoney(arTotal)} outstanding`}>
          {loading ? <TileLoading /> : (
            <div className="px-5 py-4 space-y-2.5">
              {AGING_ORDER.map(b => {
                const bucket = arAging[b.key] || { count: 0, total: 0 }
                return (
                  <div key={b.key} className="flex items-center justify-between">
                    <span className="text-sm text-ink-2">{b.label}</span>
                    <div className="flex items-baseline gap-2">
                      <span className={`text-sm tabular-nums ${b.tone}`}>{fmtMoney(bucket.total)}</span>
                      <span className="text-[11px] text-ink-3 tabular-nums w-10 text-right">
                        {bucket.count} {bucket.count === 1 ? 'invoice' : 'invoices'}
                      </span>
                    </div>
                  </div>
                )
              })}
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
                    <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden">
                      <div className="h-full bg-violet-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Tile>
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
                 className="flex items-center gap-3 px-5 py-3 hover:bg-bg transition-colors">
                <span className="grid place-items-center w-6 h-6 rounded-full bg-bg-2 text-[11px] font-semibold text-ink-3 tabular-nums shrink-0">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink truncate">{c.client_name}</div>
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
  )
}
