import { Fragment } from 'react'
import { ArrowRight, TrendingUp } from 'lucide-react'
import { SOFT_CARD } from './constants'

/** One stage in the horizontal Lead → Quoted → Accepted → Won strip:
 *  large count on top, tinted relative-volume bar under it, optional
 *  subtitle, and an arrow to the next stage (hidden when `last`). */
function FunnelStage({ label, n, tone, pct, sub, onClick, last }) {
  return (
    <Fragment>
      <button onClick={onClick}
        className="flex-1 min-w-0 text-left rounded-xl border border-hairline bg-panel p-3.5 hover:shadow-md hover:border-hairline-2 transition-all">
        <div className={`text-[10px] font-bold uppercase tracking-wide ${tone.text}`}>{label}</div>
        <div className="text-[26px] leading-none font-bold text-ink tabular-nums mt-1.5">{n}</div>
        <div className="mt-2.5 h-1.5 rounded-full bg-bg-2 overflow-hidden">
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(pct, n > 0 ? 8 : 0)}%` }} />
        </div>
        {sub && <div className="text-[10px] text-ink-3 mt-1.5 truncate">{sub}</div>}
      </button>
      {!last && (
        <div className="hidden sm:flex items-center self-center shrink-0">
          <ArrowRight className="w-4 h-4 text-ink-3" />
        </div>
      )}
    </Fragment>
  )
}

/** Lead → client funnel. A horizontal, visual conversion strip: New leads
 *  → Quoted → Accepted → Won, with a relative-volume bar under each stage
 *  and arrows between. This is the at-a-glance answer to "are we turning
 *  leads into clients?". Header row shows the conversion rate and the
 *  active-client count. */
export function Funnel({ stages, convRate, activeClients }) {
  const max = Math.max(1, ...stages.map(s => s.n))
  return (
    <div className={`${SOFT_CARD} p-5`}>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="grid place-items-center w-8 h-8 rounded-xl shrink-0 bg-purple-50 text-purple-600">
            <TrendingUp className="w-4 h-4" />
          </span>
          <h2 className="text-sm font-semibold text-ink">Lead → client funnel</h2>
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          <span className="text-ink-3">
            <span className="font-bold text-ink tabular-nums">{convRate}%</span> won
          </span>
          {activeClients != null && (
            <span className="text-ink-3">
              <span className="font-bold text-emerald-600 tabular-nums">{activeClients}</span> active clients
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        {stages.map((s, i) => (
          <FunnelStage key={s.key} {...s} pct={Math.round((s.n / max) * 100)} last={i === stages.length - 1} />
        ))}
      </div>
    </div>
  )
}
