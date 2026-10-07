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
 *
 * Turnover-feed health and stalled recurring series used to sit here too,
 * as read-only copies of what /sync and /recurring already own. Home now
 * carries the triage view of both (components/board/SnapshotBoxes.jsx, off
 * the board payload it already fetches), so this page went back to being
 * about money and capacity — and shed two fetches doing it.
 *
 * Not linked from the main Dashboard on purpose — this is an owner tool,
 * not a daily-operations tile. Sidebar entry gates on admin/manager via
 * the Sidebar's badges (the backend also 403s viewers on /owner and the
 * financial widgets).
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  TrendingUp, DollarSign, Repeat, AlertTriangle, PieChart, Users, Building2, Sparkles,
} from 'lucide-react'
import { get } from '../api'
import { toLocalYMD } from '../utils/format'
import { fmtMoney } from '../components/dashboard/utils'
import { KpiCard, Tile, TileLoading, BarTip } from '../components/dashboard/primitives'
import { PropertyEconomicsTile } from '../components/dashboard/PropertyEconomicsTile'
import { WeekCapacityTile } from '../components/dashboard/WeekCapacityTile'
import { OperatingHealthTile } from '../components/dashboard/OperatingHealthTile'
import { ErrorState, PageHeader, SubNav } from '../components/ui'
import { STATUS_DOT } from '../theme/statusDots'
import { STATUS_TEXT } from '../theme/statusText'

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
  { key: '0_30',    label: '0–30 days',  tone: STATUS_TEXT.attention, status: 'overdue' },
  { key: '31_60',   label: '31–60 days', tone: 'text-orange-600 dark:text-orange-300', status: 'overdue' },
  { key: '61_90',   label: '61–90 days', tone: STATUS_TEXT.problem, status: 'overdue' },
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

/** AI provider status + live self-test. Answers "which LLM is BrightBase on
 *  and does it work?" — reads /api/admin/ai-health, and "Run self-test" hits
 *  ?probe=1 to run a real completion + a real tool-using loop (the path the
 *  Workspace assistant uses) and surface the actual error if one fails. */
function AiHealthTile() {
  const [info, setInfo] = useState(null)
  const [err, setErr] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState(null)

  useEffect(() => {
    let off = false
    get('/api/admin/ai-health')
      .then(d => { if (!off) setInfo(d) })
      .catch(() => { if (!off) setErr(true) })
    return () => { off = true }
  }, [])

  const runProbe = async () => {
    setProbing(true); setProbe(null)
    try {
      const d = await get('/api/admin/ai-health?probe=1')
      setInfo(d); setProbe(d.probes || {})
    } catch {
      setProbe({ _fatal: true })
    } finally {
      setProbing(false)
    }
  }

  const Row = ({ label, children }) => (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-ink-2">{label}</span>
      <span className="text-sm text-ink tabular-nums">{children}</span>
    </div>
  )

  const ProbeResult = ({ name, r }) => {
    if (!r) return null
    return (
      <div className="flex items-start gap-2 py-1.5">
        <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? STATUS_DOT.ok : STATUS_DOT.problem}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink-2">{name}</div>
          {r.ok
            ? <div className="text-[12px] text-ink-3 break-words">OK — {typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}</div>
            : <div className={`text-[12px] ${STATUS_TEXT.problem} break-words`}><span className="font-semibold">{r.error_type}</span>: {r.error}</div>}
        </div>
      </div>
    )
  }

  return (
    <Tile icon={Sparkles} iconColor="violet" title="AI assistant health">
      {err ? (
        <div className="px-5 py-6 text-sm text-ink-3">Couldn't load AI status.</div>
      ) : !info ? (
        <TileLoading />
      ) : (
        <div className="px-5 py-4">
          <Row label="Provider">{info.provider}</Row>
          <Row label="Key configured">
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${info.available ? STATUS_DOT.ok : STATUS_DOT.problem}`} aria-hidden="true" />
              {info.available ? 'yes' : 'no'}
            </span>
          </Row>
          <Row label="Model (standard)">{info.models?.sonnet}</Row>
          <div className="mt-3 pt-3 border-t border-hairline">
            {probe && !probe._fatal && (
              <div className="mb-2">
                <ProbeResult name="Text completion" r={probe.completion} />
                <ProbeResult name="Tool-using loop (simple)" r={probe.tool_loop} />
                <ProbeResult name="Tool loop with reasoning (assistant path)" r={probe.tool_loop_reasoning} />
              </div>
            )}
            {probe?._fatal && <div className={`mb-2 text-[12px] ${STATUS_TEXT.problem}`}>Self-test request failed.</div>}
            <button onClick={runProbe} disabled={probing}
              className="inline-flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors">
              {probing ? 'Testing…' : 'Run self-test'}
            </button>
            <p className="mt-1.5 text-[11px] text-ink-3">Runs a live check on the AI provider and shows the real error if a call fails.</p>
          </div>
        </div>
      )}
    </Tile>
  )
}

export default function OwnerDashboard() {
  const navigate = useNavigate()
  const week = currentWeekRange()

  const owner = useGet('/api/dashboard/owner')
  const economics = useGet('/api/dashboard/property-economics')
  const capacity = useGet('/api/dashboard/week-capacity')
  const health = useGet('/api/dashboard/operating-health')

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
  const arCount = AGING_ORDER.reduce((sum, b) => sum + (arAging[b.key]?.count || 0), 0)
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
      >
        <SubNav />
      </PageHeader>

      <div className="px-4 sm:px-8 pb-6 space-y-5">

      {/* Headline KPIs — the numbers Meg steers by, above the fold and dense
          (2-up on a phone, 4-up at ~940px). Past-due is a tile you can ACT on:
          it drills straight into the overdue invoice list. */}
      <div className="grid grid-cols-2 shell:grid-cols-4 gap-3 bb-board-in">
        <KpiCard
          icon={TrendingUp}
          label="Close rate (90d)"
          loading={loading}
          value={closeRate?.rate_pct != null ? `${closeRate.rate_pct}%` : 'n/a'}
          sub={closeRate
            ? `${closeRate.quotes_won} of ${closeRate.quotes_sent} sent`
            : null}
        />
        <KpiCard
          icon={Repeat}
          label="MRR estimate"
          loading={loading}
          value={fmtMoney((mrr?.estimate_cents || 0) / 100)}
          sub={mrr
            ? `${mrr.schedules_priced} priced${mrr.schedules_unpriced ? ` · ${mrr.schedules_unpriced} unpriced` : ''}`
            : null}
        />
        <KpiCard
          icon={DollarSign}
          label="Revenue paid (90d)"
          loading={loading}
          value={fmtMoney(revenueTotal)}
          sub={`${revenueByService.reduce((n, r) => n + (r.invoice_count || 0), 0)} invoices`}
        />
        {/* Clickable headline: jumps to the overdue invoice list. A quiet
            hover lift is the only motion; rose INK (never a tint) when money
            is owed. Disabled — plain ink — when nothing is past due. */}
        <button
          type="button"
          onClick={() => goInvoices('overdue')}
          disabled={!arTotal}
          className="block w-full text-left rounded-xl transition-transform duration-200 ease-out hover:-translate-y-0.5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500/40 disabled:cursor-default disabled:hover:translate-y-0">
          <KpiCard
            icon={AlertTriangle}
            label="Past due"
            loading={loading}
            value={fmtMoney(arTotal)}
            accent={arTotal > 0 ? STATUS_TEXT.problem : 'text-ink'}
            sub={`${arCount} ${arCount === 1 ? 'invoice' : 'invoices'} owed`}
          />
        </button>
      </div>

      {/* Above the fold: the two numbers the business lives on — labour share
          & repeat rate beside this week's booked-vs-available capacity. Two
          equal boxes, not a full-width band apiece. Collapses to one column
          below shell:. */}
      <div className="grid grid-cols-1 shell:grid-cols-2 gap-4 bb-board-in" style={{ animationDelay: '40ms' }}>
        <OperatingHealthTile {...health} />
        {/* This week: how packed, and who's been on the clock */}
        <WeekCapacityTile {...capacity} navigate={navigate} />
      </div>

      {/* Property economics — a wide table, so it keeps the full width. */}
      <div className="bb-board-in" style={{ animationDelay: '80ms' }}>
        <PropertyEconomicsTile {...economics} navigate={navigate} />
      </div>

      {/* Lower bento — two PACKING columns (per-column flex stacks, not a
          height-locking grid), so a short box sits straight on the next with
          no dead space. Money on the left (AR aging + revenue mix); who pays
          & systems health on the right. One column below shell:. */}
      <div className="grid grid-cols-1 shell:grid-cols-2 gap-4 bb-board-in" style={{ animationDelay: '120ms' }}>
        <div className="flex flex-col gap-4">
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
        </div>

        {/* Column B — who pays, and whether the assistant is healthy. */}
        <div className="flex flex-col gap-4">
      {/* Top clients */}
      <Tile icon={Users} iconColor="blue" title="Top clients by paid revenue (90d)">
        {loading ? <TileLoading /> : topClients.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-3">
            No client revenue in the window yet.
          </div>
        ) : (
          <div className="divide-y divide-hairline">
            {topClients.map((c, i) => (
              <Link key={c.client_id} to={`/clients/${c.client_id}`}
                 className="flex items-center gap-3 px-5 py-3 hover:bg-bg-2/60 transition-colors no-underline">
                <span className="w-5 text-right text-[11px] font-semibold text-ink-3 tabular-nums shrink-0">
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
              </Link>
            ))}
          </div>
        )}
      </Tile>

      {/* AI provider status + live self-test — surfaces which LLM is active
          and the real error when the assistant fails. */}
      <AiHealthTile />
        </div>
      </div>
      </div>
    </div>
  )
}
