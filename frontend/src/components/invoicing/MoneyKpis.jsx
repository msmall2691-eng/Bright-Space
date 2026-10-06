/**
 * MoneyKpis — the money band that leads the page: the three numbers the owner
 * checks first (Collected / Outstanding / Overdue) plus a compact AR-aging strip
 * that splits the outstanding balance by how late it is.
 *
 * Pure view. Every figure is derived in `useInvoicing` from the invoices the
 * page already fetched — zero extra requests (brightbase-economy). Chrome is the
 * quiet SnapshotBoxes vocabulary: hairline card, 6px semantic dot, 11px
 * sentence-case label, big plain ink number, `tabular-nums` on money. No pills,
 * no tinted banners, no count bubbles — color rides the dots, which mean
 * something (amber = getting late, red = overdue).
 *
 * Operable, not read-only: Collected / Overdue tiles filter the list to that set
 * on click (clear 1:1 status mapping), and the Overdue tile carries the "Chase
 * overdue" action inline (the one place the overdue count + its action live, so
 * the header stays a single primary). The aging strip renders NOTHING when there
 * is nothing outstanding — no permanent all-clear furniture.
 */
import { usd } from './constants'
import { STATUS_DOT } from '../../theme/statusDots'

/** One headline number. When `onFilter` is set the card body is a button that
 *  narrows the list to that status; `active` marks it as the current filter with
 *  a heavier hairline. Tiles stay a uniform height (no inline buttons that would
 *  stretch the grid row and leave dead space beside them). */
function StatTile({ dot, label, value, sub, onFilter, active, title }) {
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="truncate text-[11px] font-medium text-ink-3">{label}</span>
      </div>
      <div className="mt-1.5 text-[19px] font-semibold leading-none tabular-nums text-ink">{value}</div>
      {sub ? <div className="mt-1 truncate text-[11px] text-ink-3 tabular-nums">{sub}</div> : null}
    </>
  )
  const cls = `rounded-xl border bg-panel px-3.5 py-3 transition-colors ${active ? 'border-hairline-2' : 'border-hairline'}`
  return onFilter ? (
    <button type="button" onClick={onFilter} title={title}
      className={`${cls} block w-full text-left hover:bg-bg-2`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

const AGE_ROWS = [
  { key: 'current',  label: 'Not yet due', dot: 'bg-ink-3' },
  { key: 'd1_30',    label: '1–30 days',   dot: STATUS_DOT.attention },
  { key: 'd31_60',   label: '31–60 days',  dot: STATUS_DOT.attention },
  { key: 'd60_plus', label: '60+ days',    dot: STATUS_DOT.problem },
]

/** Outstanding balance broken out by age — answers "how stale is the money
 *  people owe me". A compact horizontal strip (4-up at shell width, 2-up on a
 *  phone) so it sits at roughly tile height instead of a tall full-width band.
 *  Rendered only by the parent when something is actually outstanding. */
function AgingStrip({ aging, outstanding }) {
  return (
    <div className="rounded-xl border border-hairline bg-panel px-3.5 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-medium text-ink-3">Outstanding by age</span>
        <span className="ml-auto text-[11px] tabular-nums text-ink-3">{usd(outstanding)}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 shell:grid-cols-4">
        {AGE_ROWS.map(r => (
          <div key={r.key} className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.dot}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{r.label}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-ink">{usd(aging[r.key])}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function MoneyKpis({
  collected, outstanding, overdue, overdueCount, aging,
  statusFilter, setStatusFilter,
}) {
  const setFilter = setStatusFilter || (() => {})
  return (
    <div className="bb-board-in space-y-2.5">
      <div className="grid grid-cols-3 items-start gap-2 shell:gap-3">
        <StatTile dot={STATUS_DOT.ok} label="Collected" value={usd(collected)}
          onFilter={() => setFilter('paid')} active={statusFilter === 'paid'}
          title="Show paid invoices" />
        <StatTile dot={outstanding > 0 ? STATUS_DOT.attention : 'bg-ink-3'}
          label="Outstanding" value={usd(outstanding)} />
        <StatTile dot={overdueCount > 0 ? STATUS_DOT.problem : 'bg-ink-3'}
          label="Overdue" value={usd(overdue)}
          onFilter={() => setFilter('overdue')} active={statusFilter === 'overdue'}
          title="Show overdue invoices"
          sub={overdueCount > 0
            ? `${overdueCount} ${overdueCount === 1 ? 'invoice' : 'invoices'}`
            : 'none'} />
      </div>
      {outstanding > 0 && <AgingStrip aging={aging} outstanding={outstanding} />}
    </div>
  )
}
