/**
 * ArAgingTile — "Collect this morning".
 *
 * The dashboard already computes accounts-receivable aging in
 * `useDashboardDerived` (the `arAging` memo: current / 30 / 60 / 90 buckets),
 * but until now it was thrown away — nothing on the page rendered it. This
 * tile surfaces it so the operator can see, at a glance, how much money is
 * stale and how old it is, then click a bucket straight through to the
 * matching invoice list.
 *
 * Design (Twenty CRM + dataviz skill):
 *   • Flat SOFT_CARD surface, hairline divider rows — no competing chrome.
 *   • Color is reserved for status: `current` stays calm ink; overdue rows
 *     escalate amber → red as the age climbs. It's never decoration.
 *   • The dollar amount is the hero (tabular-nums, right-aligned); the age
 *     band and invoice count are the supporting context.
 */
import { DollarSign, ArrowRight } from 'lucide-react'
import { SOFT_CARD } from './constants'
import { fmtMoney } from './utils'

/** Bucket presentation, oldest-money-first is deliberately NOT the order —
 *  we read youngest → oldest so the eye lands on "90+" (the real problem)
 *  at the bottom, matching how an aging report is conventionally scanned.
 *  `sumTone` recolors only the amount, so the row chrome stays flat. */
const BUCKETS = [
  { key: 'current', label: 'Current', hint: 'not yet 30 days', sumTone: 'text-ink',
    status: 'sent' },
  { key: '30', label: '30–60 days', hint: 'past due', sumTone: 'text-amber-600 dark:text-amber-300',
    status: 'overdue' },
  { key: '60', label: '60–90 days', hint: 'past due', sumTone: 'text-amber-700 dark:text-amber-400',
    status: 'overdue' },
  { key: '90', label: '90+ days', hint: 'at risk', sumTone: 'text-red-600 dark:text-red-300',
    status: 'overdue' },
]

const sumBucket = (rows) => (rows || []).reduce((s, i) => s + (i.total || 0), 0)

export function ArAgingTile({ loading, arAging, navigate }) {
  const buckets = arAging || { current: [], 30: [], 60: [], 90: [] }
  const outstandingTotal = BUCKETS.reduce((s, b) => s + sumBucket(buckets[b.key]), 0)
  const anyOutstanding = BUCKETS.some(b => (buckets[b.key] || []).length > 0)

  const go = (status) =>
    navigate(`/billing?view=invoices${status ? `&status=${status}` : ''}`)

  return (
    <section className={`${SOFT_CARD} overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-hairline">
        <div className="flex items-center gap-2.5 min-w-0">
          <DollarSign className="w-4 h-4 shrink-0 text-ink-3" />
          <h2 className="text-sm font-semibold text-ink truncate">Collect this morning</h2>
        </div>
        <button onClick={() => go('overdue')}
          className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-0.5 shrink-0">
          Invoices <ArrowRight className="w-3 h-3" />
        </button>
      </div>

      {loading ? (
        <div className="p-4 space-y-2">{[0, 1, 2, 3].map(i => (
          <div key={i} className="h-9 rounded-lg bg-bg-2 animate-pulse" />
        ))}</div>
      ) : !anyOutstanding ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-semibold text-ink">Nothing to collect</p>
          <p className="text-[12px] text-ink-3 mt-0.5">No outstanding receivables — you're all paid up.</p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-hairline">
            {BUCKETS.map(b => {
              const rows = buckets[b.key] || []
              const total = sumBucket(rows)
              const disabled = rows.length === 0
              return (
                <button key={b.key} disabled={disabled} onClick={() => go(b.status)}
                  className={`w-full flex items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors ${
                    disabled ? 'opacity-45 cursor-default' : 'hover:bg-bg'}`}>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate">{b.label}</div>
                    <div className="text-[11px] text-ink-3 truncate">
                      {rows.length} {rows.length === 1 ? 'invoice' : 'invoices'} · {b.hint}
                    </div>
                  </div>
                  <span className={`text-sm font-bold tabular-nums shrink-0 ${b.sumTone}`}>
                    {fmtMoney(total)}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-hairline bg-bg/40">
            <span className="text-[12px] font-semibold text-ink-2">Outstanding</span>
            <span className="text-base font-bold tabular-nums text-ink">{fmtMoney(outstandingTotal)}</span>
          </div>
        </>
      )}
    </section>
  )
}
