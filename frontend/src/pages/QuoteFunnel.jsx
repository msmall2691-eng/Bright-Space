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
import { Link } from 'react-router-dom'
import { ErrorState, PageHeader, SubNav } from '../components/ui'
import { SEV_DOT } from '../components/board/tokens'

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

// Current-status outcome mix among the quoted requests.
//
// COLOUR DOES TWO SEPARATE JOBS HERE and it used to do them with one channel.
// Every row carried its own hue on BOTH the bar and the count, which was wrong
// twice over (dataviz): "text wears text tokens, never the series colour", and
// "status tokens only when the colour means good/bad — never both in one chart".
// Quote outcomes do mean good/bad, so the six-hue palette was a categorical
// treatment doing a status job — `teal` was invented for it and is not in the
// design language's vocabulary at all. Measured, every step also failed its
// floor against this page's own grounds: bars at 1.77-2.09:1 against a 3:1
// non-text floor, counts at 3.99-4.19:1 against 4.5:1.
//
// So: the BAR encodes share, which is magnitude, and magnitude is one hue (the
// accent). The DOT encodes state, from the house vocabulary only. The count is
// plain ink. Rows may share a dot colour — right, because the dot says what KIND
// of state this is, not which row it is, and the label disambiguates.
//
// `to` is the quotes list filtered to this state, or null where no such filter
// exists. See the comment on OUTCOME_LINK below — three of the six genuinely
// cannot be linked, and pretending otherwise would be worse than not linking.
const OUTCOME_ORDER = [
  { key: 'won', label: 'Won', dot: SEV_DOT.good },
  { key: 'accepted', label: 'Accepted · to schedule', dot: SEV_DOT.watch },
  { key: 'changes_requested', label: 'Changes requested', dot: SEV_DOT.watch },
  { key: 'open', label: 'In play · awaiting reply', dot: 'bg-ink-3' },
  { key: 'declined', label: 'Declined', dot: SEV_DOT.urgent },
  { key: 'expired', label: 'Expired', dot: 'bg-ink-3' },
]

// Where a number can take you. Verified against the backend's own mapping
// (dashboard/analytics.py — `st == "converted"` lands in `won`, and so on), not
// assumed, because a link to the wrong list is worse than no link.
//
// THREE OUTCOMES ARE DELIBERATELY ABSENT. `expired` and `changes_requested` have
// no segment in QuotesToolbar's STATUS_SEGMENTS, and `open` is three statuses at
// once (draft / sent / viewed) which one query param cannot express. A link for
// those would land you on a list whose own filter UI cannot show the state you
// asked for. They stay plain rows until the quotes list can express them.
const OUTCOME_LINK = {
  won: '/quotes?status=converted',
  accepted: '/quotes/accepted',
  declined: '/quotes?status=declined',
}

// Funnel stages → the page that owns those records. `quoted` has no single
// status (it means "a quote exists at all"), so it points at the unfiltered
// list rather than a wrong filter.
const STAGE_LINK = {
  requests: '/requests',
  quoted: '/quotes',
  sent: '/quotes?status=sent',
  viewed: '/quotes?status=viewed',
  accepted: '/quotes/accepted',
  won: '/quotes?status=converted',
}

/** A number that goes somewhere. Falls back to plain text when it does not. */
function Reach({ to, title, className = '', children }) {
  if (!to) return <span className={className}>{children}</span>
  return (
    <Link to={to} title={title}
      className={`bb-focus rounded-sm no-underline hover:text-link ${className}`}>
      {children}
    </Link>
  )
}

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
                <Reach to={STAGE_LINK[stage.key]}
                  title={`Open the ${stage.label.toLowerCase()} behind this number`}
                  className="text-sm font-medium text-ink truncate">
                  {stage.label}
                </Reach>
                {step != null && (
                  <span className="text-[10px] font-semibold text-ink-3 tabular-nums">↓ {step}%</span>
                )}
              </div>
              <div className="flex items-baseline gap-2 shrink-0">
                {stage.value != null && (
                  <span className="text-[11px] text-ink-3 tabular-nums">{fmtMoney(stage.value)}</span>
                )}
                <Reach to={STAGE_LINK[stage.key]}
                  title={`Open the ${stage.label.toLowerCase()} behind this number`}
                  className="text-sm font-semibold text-ink tabular-nums">
                  {stage.count}
                </Reach>
                <span className="text-[11px] text-ink-3 tabular-nums w-10 text-right">{shareOfTop}%</span>
              </div>
            </div>
            <div className="h-2 bg-bg-2 rounded-full overflow-hidden"
              title={`${stage.count} of ${requests} — ${shareOfTop}% of requests`}>
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
      >
        <SubNav />
      </PageHeader>

      <div className="px-4 sm:px-8 pb-6 space-y-5">
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
                    ? 'bg-bg-2 text-ink shadow-xs'
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
            {/* KPI row — 4-up at shell: (the owner's ~940px window), not lg:
                (1024), so her window gets the full row instead of a 2×2 block. */}
            <div className="grid grid-cols-2 shell:grid-cols-4 gap-3">
              <KpiCard
                icon={Inbox}
                label="Requests"
                loading={loading}
                value={requests}
                sub={`last ${days} days`}
              />
              <KpiCard
                icon={FileText}
                label="Request → quote"
                loading={loading}
                value={pctLabel(conversion.request_to_quote_pct)}
                sub={`${quoted} of ${requests} quoted`}
              />
              <KpiCard
                icon={Trophy}
                label="Win rate"
                loading={loading}
                value={pctLabel(conversion.overall_pct)}
                sub={`${won} won of ${requests}`}
              />
              <KpiCard
                icon={DollarSign}
                label="Won value"
                loading={loading}
                value={fmtMoney(value.won || 0)}
                sub={`${fmtMoney(value.quoted || 0)} quoted`}
              />
            </div>

            {/* THE BENTO. This was three stacked full-width zones — the funnel
                tile, a 2-up pair, then the by-source table — on a page with no
                scroll region, so the page simply WAS the stack and you scrolled
                past four tiles to reach the fourth.

                Two columns of per-column flex stacks, not a grid of rows: a grid
                ties every tile in a row to the tallest one, which is how a
                2-number turnaround box ends up as tall as a 6-row funnel (owner:
                "too much empty spaces"). Stacks let a short tile sit directly on
                the next. Paired so the heights balance — the tall funnel against
                the two medium tables.

                `shell:` (900px), never `lg:` (1024): the owner's window is
                ~940px and a plain lg: has hidden a whole redesign from her once.
                One column below that, same reading order. */}
            <div className="grid grid-cols-1 items-start gap-5 shell:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-5">
                <Tile icon={TrendingUp} title={`Conversion funnel · last ${days} days`}>
                  {loading ? <TileLoading /> : <FunnelBars funnel={funnel} conversion={conversion} />}
                </Tile>
                <Tile icon={Clock} title="Turnaround (median)">
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

              <div className="flex min-w-0 flex-col gap-5">
                <Tile icon={Layers} title="Quote outcomes">
                {loading ? <TileLoading /> : quotedTotal === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-ink-3">No quotes in the window yet.</div>
                ) : (
                  <div className="px-5 py-4 space-y-2.5">
                    {OUTCOME_ORDER.map(o => {
                      const n = outcomes[o.key] || 0
                      const pct = quotedTotal > 0 ? Math.round((n / quotedTotal) * 100) : 0
                      const to = OUTCOME_LINK[o.key]
                      const hint = to
                        ? `Open the ${o.label.split(' · ')[0].toLowerCase()} quotes`
                        : `${n} of ${quotedTotal} quotes`
                      return (
                        <div key={o.key}>
                          <div className="flex items-center justify-between gap-3 mb-1">
                            {/* Bare dot + word: the dot says what kind of state
                                this is, the label says which one. */}
                            <span className="flex min-w-0 items-center gap-2">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${o.dot}`} aria-hidden="true" />
                              <Reach to={to} title={hint} className="truncate text-sm text-ink-2">
                                {o.label}
                              </Reach>
                            </span>
                            {/* Plain ink. The count is text, and text wears text
                                tokens — the series colour lives on the dot. */}
                            <Reach to={to} title={hint} className="shrink-0 text-sm tabular-nums text-ink">
                              {n} <span className="text-[11px] text-ink-3">· {pct}%</span>
                            </Reach>
                          </div>
                          <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden" title={hint}>
                            {/* One hue for every row: the bar encodes share,
                                and share is magnitude. */}
                            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                </Tile>
                <Tile icon={Globe} title="By lead source">
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
                          {/* ?source= became a real filter in #1095 — before that
                              this table counted leads it could not show you. */}
                          <Reach to={`/requests?source=${encodeURIComponent(r.source)}`}
                            title={`Open the ${r.source} leads`}
                            className="col-span-5 truncate text-sm capitalize text-ink">
                            {r.source}
                          </Reach>
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
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
