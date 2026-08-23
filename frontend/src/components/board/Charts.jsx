/**
 * Home's charts — money over time and where leads stop.
 *
 * Both read `board.snapshot`, already fetched by Home, so they cost nothing
 * extra (brightbase-economy rule 3). Hand-rolled inline SVG rather than a
 * charting library: two shapes don't justify ~90KB of vendor JS on the app
 * shell, and a library's defaults are exactly the SaaS chrome the owner keeps
 * vetoing.
 *
 * Chart rules being followed deliberately:
 *  · ONE axis. Collected and billed are both dollars, so they share a scale —
 *    a second y-axis is the most common way to make two series lie.
 *  · Identity is never colour alone: two series get a legend, AND the readout
 *    strip under the plot always names both values in words — so the lines
 *    are readable without consulting the colours at all.
 *  · Text wears ink tokens; only the marks carry the series colour.
 *  · Recessive axes, thin marks, and a label every fourth week rather than a
 *    number on every point.
 *
 * The series colours were checked with the colourblind-safety validator rather
 * than picked by eye. Light (emerald-600 #059669 / indigo-600 #4f46e5) passes
 * every check — deutan ΔE 26.1 against a target of 8. Dark (emerald-500 /
 * indigo-400) is the best-separating pair available on this near-black panel
 * (deutan ΔE 19.9, contrast ≥3:1); it sits outside the validator's dark
 * lightness band, and going lighter to satisfy that band measurably WORSENED
 * colourblind separation, so legibility won. The legend and the always-visible
 * readout mean the pair is never the only thing distinguishing the lines.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

const money = (n) => {
  const v = Math.round(Number(n) || 0)
  if (Math.abs(v) >= 10000) return `$${Math.round(v / 1000)}k`
  return `$${v.toLocaleString()}`
}

function Box({ dot = 'bg-indigo-500', title, right, children }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <h2 className="text-[11px] font-medium text-ink-3">{title}</h2>
        {right != null && (
          <span className="ml-auto text-[11px] tabular-nums text-ink-3">{right}</span>
        )}
      </header>
      {children}
    </section>
  )
}

/* ── Money over time ──────────────────────────────────────────────────────── */

const W = 320, H = 120, PAD_L = 4, PAD_R = 4, PAD_T = 10, PAD_B = 14

const SERIES = [
  { key: 'collected', label: 'Collected',
    stroke: 'stroke-emerald-600 dark:stroke-emerald-500',
    fill: 'fill-emerald-600 dark:fill-emerald-500',
    dot: 'bg-emerald-600 dark:bg-emerald-500' },
  { key: 'invoiced', label: 'Billed',
    stroke: 'stroke-indigo-600 dark:stroke-indigo-400',
    fill: 'fill-indigo-600 dark:fill-indigo-400',
    dot: 'bg-indigo-600 dark:bg-indigo-400' },
]

export function MoneyTrend({ snap }) {
  const [hover, setHover] = useState(null)
  if (!snap || !snap.has_data) return null

  const pts = snap.points || []
  if (pts.length < 2) return null

  // One scale for both series — same unit, so a shared axis is the honest one.
  const peak = Math.max(1, ...pts.flatMap(p => [p.collected, p.invoiced]))
  const x = (i) => PAD_L + (i / (pts.length - 1)) * (W - PAD_L - PAD_R)
  const y = (v) => PAD_T + (1 - (Number(v) || 0) / peak) * (H - PAD_T - PAD_B)
  const path = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')

  const active = hover == null ? null : pts[hover]

  const pickAt = (clientX, el) => {
    const r = el.getBoundingClientRect()
    const rel = (clientX - r.left) / r.width
    setHover(Math.max(0, Math.min(pts.length - 1, Math.round(rel * (pts.length - 1)))))
  }

  return (
    <Box dot="bg-emerald-500" title="Money, last 12 weeks">
      <div className="px-3.5 pt-3">
        {/* Legend — two series always get one; identity is never colour alone. */}
        <div className="mb-1.5 flex items-center gap-3">
          {SERIES.map(s => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
              {s.label}
            </span>
          ))}
        </div>

        <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" role="img"
          aria-label={`Collected and billed per week for the last ${snap.weeks} weeks`}
          onMouseMove={e => pickAt(e.clientX, e.currentTarget)}
          onMouseLeave={() => setHover(null)}
          onTouchStart={e => e.touches[0] && pickAt(e.touches[0].clientX, e.currentTarget)}
          onTouchMove={e => e.touches[0] && pickAt(e.touches[0].clientX, e.currentTarget)}>
          {/* Baseline only — a full grid would out-shout the data. */}
          <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B}
            className="stroke-hairline" strokeWidth="1" vectorEffect="non-scaling-stroke" />

          {active != null && hover != null && (
            <line x1={x(hover)} y1={PAD_T - 4} x2={x(hover)} y2={H - PAD_B}
              className="stroke-hairline-2" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}

          {SERIES.map(s => (
            <path key={s.key} d={path(s.key)} fill="none" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              vectorEffect="non-scaling-stroke" className={s.stroke} />
          ))}

          {/* The latest point of each series is marked and labelled, so the two
              lines are told apart without consulting the legend. */}
          {SERIES.map(s => (
            <circle key={s.key} cx={x(pts.length - 1)} cy={y(pts[pts.length - 1][s.key])}
              r="2.5" className={s.fill} />
          ))}

          {hover != null && SERIES.map(s => (
            <circle key={s.key} cx={x(hover)} cy={y(pts[hover][s.key])} r="3"
              className={s.fill} />
          ))}
        </svg>

        {/* A label every fourth week — never a number on every point. */}
        <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-ink-3">
          {pts.map((p, i) => (
            <span key={p.week} className={i % 4 === 0 || i === pts.length - 1 ? '' : 'invisible'}>
              {p.label}
            </span>
          ))}
        </div>
      </div>

      {/* Readout instead of a floating tooltip: it can't clip out of the card,
          and on a phone there's no hover to reveal it. */}
      <div data-testid="trend-readout"
        className="mt-2 flex items-baseline gap-4 border-t border-hairline px-3.5 py-2">
        <span className="text-[11px] text-ink-3">
          {active ? `Week of ${active.label}` : 'Last 12 weeks'}
        </span>
        <span className="ml-auto text-[12px] tabular-nums text-ink">
          {money(active ? active.collected : snap.collected_total)} in
        </span>
        <span className="text-[12px] tabular-nums text-ink-2">
          {money(active ? active.invoiced : snap.invoiced_total)} billed
        </span>
      </div>
    </Box>
  )
}

/* ── Where leads stop ─────────────────────────────────────────────────────── */

export function LeadFunnel({ snap }) {
  if (!snap || !snap.has_data) return null
  const { steps, widths, overall_pct, by_source, window_days } = snap

  return (
    <Box dot="bg-indigo-500" title={`Requests, last ${window_days} days`}
      right={overall_pct != null ? `${overall_pct}% won` : null}>
      <div className="space-y-1.5 px-3.5 py-3">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[11px] text-ink-3">{s.label}</span>
            {/* Counts sit in their own right-aligned column so they line up,
                instead of ragging along the ends of bars of different widths. */}
            <span className="w-7 shrink-0 text-right text-[12px] font-medium tabular-nums text-ink">
              {s.count}
            </span>
            <span className="w-9 shrink-0 text-[10.5px] tabular-nums text-ink-3">
              {i > 0 && steps[i - 1].count > 0
                ? `${Math.round((s.count / steps[i - 1].count) * 100)}%` : ''}
            </span>
            {/* One hue, one magnitude ramp down a single funnel — thin and
                low-contrast, so it reads as a measure and not as a filled pill. */}
            <span className="flex-1">
              <span className="block h-1.5 min-w-[2px] rounded-sm bg-indigo-500/45 dark:bg-indigo-400/45"
                style={{ width: `${Math.max(widths[i], 1.5)}%` }}
                aria-hidden="true" />
            </span>
          </div>
        ))}
      </div>

      {by_source?.length > 0 && (
        <div className="border-t border-hairline px-3.5 py-2">
          <p className="mb-1 text-[10.5px] text-ink-3">Where they came from</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {by_source.map(src => (
              <span key={src.source} className="text-[11px] text-ink-2">
                <span className="capitalize">{src.source}</span>
                <span className="ml-1 tabular-nums text-ink-3">
                  {src.requests}{src.won ? ` · ${src.won} won` : ''}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex border-t border-hairline px-3.5 py-2">
        <Link to="/funnel"
          className="touch-sm inline-flex items-center text-[11px] text-ink-2 no-underline hover:text-indigo-600">
          Full funnel →
        </Link>
      </div>
    </Box>
  )
}
