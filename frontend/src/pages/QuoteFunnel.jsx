/**
 * QuoteFunnel — the intake → quote conversion funnel (an owner/manager tool).
 *
 * Consumes GET /api/dashboard/funnel?days=N. The endpoint returns a cohort
 * funnel anchored on the REQUEST (LeadIntake): every request in the window is
 * followed to its linked quote's furthest stage, so the stages are cumulative
 * and monotonic (Requests ≥ Quoted ≥ Sent ≥ Viewed ≥ Accepted ≥ Won). This
 * page is presentation-only — all the aggregation math lives on the backend.
 *
 * Presentation follows OwnerDashboard: PageHeader, KpiCard row, Tile shells,
 * and the single-hue magnitude-bar idiom (no chart library in this app).
 */
import { useEffect, useState } from 'react'
import {
  TrendingUp, Inbox, FileText, Trophy, DollarSign, Clock, Layers, Globe,
} from 'lucide-react'
import { get } from '../api'
import { fmtMoney } from '../components/dashboard/utils'
import { KpiCard, Tile, TileLoading } from '../components/dashboard/primitives'
import { ErrorState, PageHeader } from '../components/ui'

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
]

// The step-conversion (from the previous stage) that belongs above each stage.
const STEP_KEY = {
  quoted: 'request_to_quote_pct',
  sent: 'quote_to_sent_pct',
  viewed: 'sent_to_viewed_pct',
  accepted: 'viewed_to_accepted_pct',
  won: 'accepted_to_won_pct',
}

// Current-status outcome mix among the quoted requests. Tone is semantic
// (green = won, red = lost), never decorative.
const OUTCOME_ORDER = [
  { key: 'won', label: 'Won', bar: 'bg-emerald-500', tone: 'text-emerald-600 dark:text-emerald-300' },
  { key: 'accepted', label: 'Accepted · to schedule', bar: 'bg-teal-500', tone: 'text-teal-600 dark:text-teal-300' },
  { key: 'changes_requested', label: 'Changes requested', bar: 'bg-amber-500', tone: 'text-amber-600 dark:text-amber-300' },
  { key: 'open', label: 'In play · awaiting reply', bar: 'bg-indigo-500', tone: 'text-indigo-600 dark:text-indigo-300' },
  { key: 'declined', label: 'Declined', bar: 'bg-red-500', tone: 'text-red-600 dark:text-red-300' },
  { key: 'expired', label: 'Expired', bar: 'bg-ink-3', tone: 'text-ink-3' },
]

const pctLabel = (p) => (p == null ? 'n/a' : `${p}%`)

/** Hours → a glanceable turnaround: '<1h', '6h', or '2.5 days'. */
function fmtDuration(hours) {
  if (hours == null) return 'n/a'
  if (hours < 1) return '<1h'
  if (hours < 48) return `${Math.round(hours)}h`
  return `${(hours / 24).toFixed(1)} days`
}

function FunnelBars({ funnel, conversion }) {
  const requests = funnel[0]?.count || 0
  if (requests === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-ink-3">
        No requests in this window yet.
      </div>
    )
  }
  return (
    <div className="px-5 py-4 space-y-3.5">
      {funnel.map((stage) => {
        const widthPct = requests > 0 ? Math.max(2, Math.round((stage.count / requests) * 100)) : 0
        const shareOfTop = requests > 0 ? Math.round((stage.count / requests) * 100) : 0
        const step = STEP_KEY[stage.key] ? conversion?.[STEP_KEY[stage.key]] : null
        return (
          <div key={stage.key}>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-ink truncate">{stage.label}</span>
                {step != null && (
                  <span className="text-[10px] font-semibold text-ink-3 tabular-nums">↓ {step}%</span>
                )}
              </div>
              <div className="flex items-baseline gap-2 shrink-0">
                {stage.value != null && (
                  <span className="text-[11px] text-ink-3 tabular-nums">{fmtMoney(stage.value)}</span>
                )}
                <span className="text-sm font-semibold text-ink tabular-nums">{stage.count}</span>
                <span className="text-[11px] text-ink-3 tabular-nums w-10 text-right">{shareOfTop}%</span>
              </div>
            </div>
            <div className="h-2 bg-bg-2 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${widthPct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function QuoteFunnel() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    get(`/api/dashboard/funnel?days=${days}`)
      .then(res => { if (!cancelled) { setData(res); setLoading(false) } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [days, reloadKey])

  const funnel = data?.funnel || []
  const conversion = data?.conversion || {}
  const outcomes = data?.outcomes || {}
  const timing = data?.timing || {}
  const value = data?.value || {}
  const bySource = data?.by_source || []

  const stage = (key) => funnel.find(s => s.key === key)?.count ?? 0
  const requests = stage('requests')
  const quoted = stage('quoted')
  const won = stage('won')
  const quotedTotal = OUTCOME_ORDER.reduce((n, o) => n + (outcomes[o.key] || 0), 0)

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <PageHeader
        title="Quote Funnel"
        subtitle={`Where requests turn into booked work — last ${days} days${data?.as_of ? ` · as of ${data.as_of}` : ''}`}
        icon={TrendingUp}
        iconColor="violet"
      />

      <div className="px-4 sm:px-6 pb-6 space-y-5">
        {/* Window selector + cohort note */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-[11px] text-ink-3 max-w-md">
            Cohort: requests received in the window, each followed to its quote's furthest stage.
          </p>
          <div className="inline-flex rounded-lg border border-hairline bg-panel p-0.5" role="group" aria-label="Time range">
            {RANGES.map(r => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                aria-pressed={days === r.days}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  days === r.days
                    ? 'bg-bg-2 text-ink shadow-sm'
                    : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <ErrorState
            title="Could not load the quote funnel"
            description="Check your connection and try again."
            onRetry={() => setReloadKey(k => k + 1)} />
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KpiCard
                icon={Inbox}
                chip="bg-bg-2 text-ink-2"
                label="Requests"
                value={loading ? '—' : requests}
                sub={loading ? 'Loading…' : `last ${days} days`}
              />
              <KpiCard
                icon={FileText}
                chip="bg-bg-2 text-ink-2"
                label="Request → quote"
                value={loading ? '—' : pctLabel(conversion.request_to_quote_pct)}
                sub={loading ? 'Loading…' : `${quoted} of ${requests} quoted`}
              />
              <KpiCard
                icon={Trophy}
                chip="bg-bg-2 text-ink-2"
                label="Win rate"
                value={loading ? '—' : pctLabel(conversion.overall_pct)}
                sub={loading ? 'Loading…' : `${won} won of ${requests}`}
              />
              <KpiCard
                icon={DollarSign}
                chip="bg-bg-2 text-ink-2"
                label="Won value"
                value={loading ? '—' : fmtMoney(value.won || 0)}
                sub={loading ? 'Loading…' : `${fmtMoney(value.quoted || 0)} quoted`}
              />
            </div>

            {/* Funnel */}
            <Tile icon={TrendingUp} iconColor="text-violet-500" title={`Conversion funnel · last ${days} days`}>
              {loading ? <TileLoading /> : <FunnelBars funnel={funnel} conversion={conversion} />}
            </Tile>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Outcomes */}
              <Tile icon={Layers} iconColor="text-purple-500" title="Quote outcomes">
                {loading ? <TileLoading /> : quotedTotal === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-ink-3">No quotes in the window yet.</div>
                ) : (
                  <div className="px-5 py-4 space-y-2.5">
                    {OUTCOME_ORDER.map(o => {
                      const n = outcomes[o.key] || 0
                      const pct = quotedTotal > 0 ? Math.round((n / quotedTotal) * 100) : 0
                      return (
                        <div key={o.key}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm text-ink-2">{o.label}</span>
                            <span className={`text-sm tabular-nums ${o.tone}`}>
                              {n} <span className="text-[11px] text-ink-3">· {pct}%</span>
                            </span>
                          </div>
                          <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${o.bar}`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Tile>

              {/* Turnaround */}
              <Tile icon={Clock} iconColor="text-blue-500" title="Turnaround (median)">
                {loading ? <TileLoading /> : (
                  <div className="px-5 py-4 grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wide">Request → quote</div>
                      <div className="text-2xl font-bold text-ink mt-1 tabular-nums">
                        {fmtDuration(timing.time_to_quote_hours_median)}
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {timing.quoted_sample || 0} {timing.quoted_sample === 1 ? 'quote' : 'quotes'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wide">Sent → accepted</div>
                      <div className="text-2xl font-bold text-ink mt-1 tabular-nums">
                        {fmtDuration(timing.time_to_accept_hours_median)}
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {timing.accepted_sample || 0} {timing.accepted_sample === 1 ? 'accept' : 'accepts'}
                      </div>
                    </div>
                  </div>
                )}
              </Tile>
            </div>

            {/* By source */}
            <Tile icon={Globe} iconColor="text-blue-500" title="By lead source">
              {loading ? <TileLoading /> : bySource.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-ink-3">No requests in the window yet.</div>
              ) : (
                <div className="divide-y divide-hairline">
                  <div className="grid grid-cols-12 gap-2 px-5 py-2 text-[10px] font-semibold text-ink-3 uppercase tracking-wide">
                    <span className="col-span-5">Source</span>
                    <span className="col-span-2 text-right">Requests</span>
                    <span className="col-span-2 text-right">Quoted</span>
                    <span className="col-span-3 text-right">Won</span>
                  </div>
                  {bySource.map(r => (
                    <div key={r.source} className="grid grid-cols-12 gap-2 px-5 py-2.5 items-center">
                      <span className="col-span-5 text-sm text-ink capitalize truncate">{r.source}</span>
                      <span className="col-span-2 text-sm text-ink-2 tabular-nums text-right">{r.requests}</span>
                      <span className="col-span-2 text-sm text-ink-2 tabular-nums text-right">{r.quoted}</span>
                      <span className="col-span-3 text-sm tabular-nums text-right text-ink">
                        {r.won} <span className="text-[11px] text-ink-3">· {pctLabel(r.won_pct)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Tile>
          </>
        )}
      </div>
    </div>
  )
}
