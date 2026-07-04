import { DollarSign } from 'lucide-react'
import { StatCard } from '../ui'
import { Tile } from './primitives'
import { fmtMoney } from './utils'

const arBucketSum = (bucket) => bucket.reduce((s, i) => s + (i.total || 0), 0)

/** "Money" tile — the full-width surface across the bottom of the page.
 *
 *  Renders three horizontally-stacked panels inside a single Tile shell:
 *   1. 4-up KPI grid: Today collected, Month-to-date, Outstanding,
 *      Pipeline. Overdue count adds an amber accent to Outstanding.
 *   2. Aging receivables row (only shown when there's aged AR): 30-60d,
 *      60-90d, 90d+ buckets, each linked to the invoices view.
 *   3. Revenue-by-service row (paid, month-to-date), one chip per
 *      service type. */
export function MoneyTile({
  todayRevenue, mtdRevenue, outstanding, pipeline,
  invoices, overdueInvoiceCount, summary,
  arAging, svcRevenue,
  navigate,
}) {
  const paidCount = invoices.filter(i => i.status === 'paid').length
  const unpaidCount = invoices.filter(i => ['sent', 'overdue'].includes(i.status)).length
  const arHasAny = arAging['30'].length + arAging['60'].length + arAging['90'].length > 0
  return (
    <Tile
      icon={DollarSign}
      iconColor="text-emerald-500"
      title="Money"
      action="Open Invoicing"
      onAction={() => navigate('/billing?view=invoices')}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-bg-2">
        <StatCard
          className="bg-panel"
          label="Today"
          value={fmtMoney(todayRevenue)}
          sub={todayRevenue > 0 ? 'collected today' : 'nothing collected yet'}
        />
        <StatCard
          className="bg-panel"
          label="Month to date"
          value={fmtMoney(mtdRevenue)}
          sub={`${paidCount} paid`}
        />
        <StatCard
          className="bg-panel"
          label="Outstanding"
          value={fmtMoney(outstanding)}
          sub={`${unpaidCount} unpaid${overdueInvoiceCount > 0 ? ` · ${overdueInvoiceCount} overdue` : ''}`}
          accent={overdueInvoiceCount > 0 ? 'text-amber-600' : 'text-ink'}
          onClick={() => navigate('/billing?view=invoices')}
        />
        <StatCard
          className="bg-panel"
          label="Pipeline"
          value={fmtMoney(pipeline)}
          sub={`${summary?.quotes?.sent ?? 0} sent · ${summary?.quotes?.draft ?? 0} draft`}
          accent="text-emerald-600"
          onClick={() => navigate('/billing?view=quotes')}
        />
      </div>

      {/* AR Aging — who to call this morning */}
      {arHasAny && (
        <div className="border-t border-hairline px-5 py-3">
          <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2">Aging receivables</div>
          <div className="flex gap-3 text-[12px]">
            {arAging['30'].length > 0 && (
              <button onClick={() => navigate('/billing?view=invoices')} className="flex items-baseline gap-1 hover:text-amber-700 transition-colors">
                <span className="text-amber-600 font-bold">{fmtMoney(arBucketSum(arAging['30']))}</span>
                <span className="text-ink-3">30-60d</span>
              </button>
            )}
            {arAging['60'].length > 0 && (
              <button onClick={() => navigate('/billing?view=invoices')} className="flex items-baseline gap-1 hover:text-orange-700 transition-colors">
                <span className="text-orange-600 font-bold">{fmtMoney(arBucketSum(arAging['60']))}</span>
                <span className="text-ink-3">60-90d</span>
              </button>
            )}
            {arAging['90'].length > 0 && (
              <button onClick={() => navigate('/billing?view=invoices')} className="flex items-baseline gap-1 hover:text-red-700 transition-colors">
                <span className="text-red-600 font-bold">{fmtMoney(arBucketSum(arAging['90']))}</span>
                <span className="text-ink-3">90d+</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Revenue by service type (paid, month-to-date) */}
      {svcRevenue.length > 0 && (
        <div className="border-t border-hairline px-5 py-3">
          <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2">Paid this month by service</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            {svcRevenue.map(s => (
              <div key={s.service} className="flex items-baseline gap-1">
                <span className="text-ink font-bold">{fmtMoney(s.total)}</span>
                <span className="text-ink-3 capitalize">{(s.service || '').replace('str_turnover', 'STR').replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Tile>
  )
}
