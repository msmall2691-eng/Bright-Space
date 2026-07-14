import { ArrowRight } from 'lucide-react'
import { Skeleton } from '../ui'
import { CHIP, SOFT_CARD } from './constants'

/** Attention row — unified across overdue / unassigned / late / overdue
 *  invoice. Colored dot on the left, title (+ optional subtitle) in the
 *  middle, right-aligned action label. Tap the whole row to jump. */
export function AttentionRow({ tone, title, sub, action, onClick }) {
  const dotClass = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
  }[tone] || 'bg-ink-3'
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-5 py-3 hover:bg-bg active:bg-bg-2 transition-colors border-b border-hairline last:border-b-0"
    >
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-ink truncate">{title}</div>
        {sub && <div className="text-[11px] text-ink-3 mt-0.5 truncate">{sub}</div>}
      </div>
      {action && (
        <span className="text-[11px] font-semibold text-blue-600 shrink-0 mt-1.5">{action}</span>
      )}
    </button>
  )
}

/** Tile shell — facelifted to the airy white card. Header row carries a
 *  tinted icon chip, title, optional badge, and a text+arrow action link.
 *  Body is unpadded so each tile manages its own spacing. */
export function Tile({ icon: Icon, iconColor, title, badge, action, onAction, children }) {
  return (
    <section className={`${SOFT_CARD} flex flex-col overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-hairline">
        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && (
            <span className={`bb-icon-chip grid place-items-center w-8 h-8 rounded-xl shrink-0 ${CHIP[iconColor] || 'bg-blue-50 text-blue-600'}`}>
              <Icon className="w-4 h-4" />
            </span>
          )}
          <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
          {badge}
        </div>
        {action && (
          <button onClick={onAction} className="text-xs font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5 shrink-0">
            {action} <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  )
}

/** KPI card — the headline stat tiles across the top of the dashboard. */
export function KpiCard({ icon: Icon, chip, label, value, sub, accent }) {
  return (
    <div className={`${SOFT_CARD} p-4`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wide truncate">{label}</span>
        <span className={`bb-icon-chip grid place-items-center w-8 h-8 rounded-xl shrink-0 ${chip}`}>
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div className={`text-2xl font-bold mt-2 tabular-nums ${accent || 'text-ink'}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-3 mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

/** A few placeholder rows while a tile's data loads. */
export function TileLoading() {
  return (
    <div className="px-4 py-3 space-y-2.5">
      {[0, 1, 2].map(i => <Skeleton key={i} className="h-11 w-full" />)}
    </div>
  )
}
