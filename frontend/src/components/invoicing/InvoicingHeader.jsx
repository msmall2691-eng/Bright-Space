import { Receipt, Plus, Search } from 'lucide-react'
import { PageHero } from '../ui'
import { STATUS_FILTERS } from './constants'


/** Compact money for the hero pods — $24K / $1.9M — so big totals never clip. */
const fmtUsd = (n) => {
  const v = Math.round(n || 0), a = Math.abs(v)
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1)}M`
  if (a >= 1e4) return `$${Math.round(v / 1e3)}K`
  return `$${v.toLocaleString()}`
}

/** Page-level header for the Invoicing list: PageHeader (title +
 *  subtitle + "Chase overdue"/"New invoice" CTAs), the 4-way
 *  metrics grid (Paid / Outstanding / Invoices / Overdue), and the
 *  search + status-filter toolbar.
 *
 *  Fully controlled — parent owns totals + counts + filter state
 *  and passes them in. */
export function InvoicingHeader({
  invoiceCount,
  totalRevenue,
  outstanding,
  overdueCount,
  search, setSearch,
  statusFilter, setStatusFilter,
  openChaser,
  openNew,
}) {
  return (
    <>
      {/* Cockpit hero — title + the four money pods, matching Home. */}
      <div className="px-4 sm:px-8 pt-4 mb-4">
        <PageHero
          icon={Receipt}
          title="Invoices"
          subtitle={`${invoiceCount} total`}
          actions={
            <>
              {overdueCount > 0 && (
                <button onClick={openChaser}
                  className="flex items-center gap-1.5 bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  title="AI-draft payment reminders for all overdue invoices">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                  Chase overdue ({overdueCount})
                </button>
              )}
              <button onClick={openNew}
                className="flex items-center gap-2 bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors">
                <Plus className="w-3.5 h-3.5" /> New invoice
              </button>
            </>
          }
          pods={[
            { label: 'Paid', value: fmtUsd(totalRevenue), tone: 'text-emerald-300' },
            { label: 'Outstanding', value: fmtUsd(outstanding), tone: 'text-amber-300' },
            { label: 'Invoices', value: invoiceCount },
            { label: 'Overdue', value: overdueCount, tone: overdueCount > 0 ? 'text-red-300' : 'text-white' },
          ]}
        />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 sm:px-8 mb-4">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="bg-panel border border-hairline text-sm text-ink placeholder-ink-3 rounded-lg pl-8 pr-3 py-1.5 focus:outline-none focus:border-hairline w-44 transition-colors" />
        </div>

        <div className="flex items-center gap-1 bg-panel border border-hairline rounded-lg p-1 overflow-x-auto">
          {STATUS_FILTERS.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                ${statusFilter === s ? 'bg-bg-2 text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
              {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
