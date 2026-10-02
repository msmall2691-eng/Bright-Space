/**
 * MoneyKpis — the money band that leads the page: the three numbers the owner
 * checks first (Collected / Outstanding / Overdue) plus a small AR-aging box
 * that splits the outstanding balance by how late it is.
 *
 * Pure view. Every figure is derived in `useInvoicing` from the invoices the
 * page already fetched — zero extra requests (brightbase-economy). Chrome is the
 * quiet SnapshotBoxes vocabulary: hairline card, 6px semantic dot, 11px
 * sentence-case label, big plain ink number, `tabular-nums` on money. No pills,
 * no tinted banners, no count bubbles — color rides the dots, which mean
 * something (amber = getting late, red = overdue).
 */
import { usd } from './constants'

/** One headline number: dot + quiet label, big plain ink value, optional sub. */
function StatTile({ dot, label, value, sub }) {
  return (
    <div className="rounded-xl border border-hairline bg-panel px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="truncate text-[11px] font-medium text-ink-3">{label}</span>
      </div>
      <div className="mt-1.5 text-[19px] font-semibold leading-none tabular-nums text-ink">{value}</div>
      {sub ? <div className="mt-1 truncate text-[11px] text-ink-3 tabular-nums">{sub}</div> : null}
    </div>
  )
}

const AGE_ROWS = [
  { key: 'current',  label: 'Not yet due', dot: 'bg-ink-3' },
  { key: 'd1_30',    label: '1–30 days',   dot: 'bg-amber-500' },
  { key: 'd31_60',   label: '31–60 days',  dot: 'bg-amber-500' },
  { key: 'd60_plus', label: '60+ days',    dot: 'bg-red-500' },
]

/** Outstanding balance broken out by age — answers "how stale is the money
 *  people owe me". Renders a quiet all-clear line when nothing is outstanding
 *  rather than a wall of $0 rows. */
function AgingBox({ aging, outstanding }) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-panel">
      <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2">
        <span className="text-[11px] font-medium text-ink-3">Outstanding by age</span>
        <span className="ml-auto text-[11px] tabular-nums text-ink-3">{usd(outstanding)}</span>
      </div>
      {outstanding > 0 ? (
        <div className="divide-y divide-hairline">
          {AGE_ROWS.map(r => (
            <div key={r.key} className="flex items-center gap-2 px-3.5 py-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.dot}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{r.label}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-ink">{usd(aging[r.key])}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-3.5 py-3 text-[12px] text-ink-3">
          Nothing outstanding — everything is paid or still a draft.
        </p>
      )}
    </div>
  )
}

export function MoneyKpis({ collected, outstanding, overdue, overdueCount, aging }) {
  return (
    <div className="bb-board-in space-y-3">
      <div className="grid grid-cols-3 gap-2 shell:gap-3">
        <StatTile dot="bg-emerald-500" label="Collected" value={usd(collected)} />
        <StatTile dot={outstanding > 0 ? 'bg-amber-500' : 'bg-ink-3'}
          label="Outstanding" value={usd(outstanding)} />
        <StatTile dot={overdueCount > 0 ? 'bg-red-500' : 'bg-ink-3'}
          label="Overdue" value={usd(overdue)}
          sub={overdueCount > 0
            ? `${overdueCount} ${overdueCount === 1 ? 'invoice' : 'invoices'}`
            : 'none'} />
      </div>
      <AgingBox aging={aging} outstanding={outstanding} />
    </div>
  )
}
