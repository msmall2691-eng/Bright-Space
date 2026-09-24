import { Receipt, Plus, Search } from 'lucide-react'
import { PageTitle } from '../ui'
import { STATUS_FILTERS } from './constants'
import { MoneyKpis } from './MoneyKpis'

/** Page-level header for the Money page: a compact PageTitle (icon + title +
 *  invoice count + "Chase overdue"/"New invoice" actions), the money band
 *  (Collected / Outstanding / Overdue + AR aging), and the search + status
 *  toolbar.
 *
 *  Fully controlled — the parent owns totals, counts, aging and filter state and
 *  passes them in. All figures are derived from the one invoices fetch the page
 *  already makes (brightbase-economy). */
export function InvoicingHeader({
  invoiceCount,
  totalRevenue,
  outstanding,
  overdueTotal,
  overdueCount,
  aging,
  search, setSearch,
  statusFilter, setStatusFilter,
  openChaser,
  openNew,
}) {
  return (
    <div className="space-y-4 px-4 pt-4 sm:px-8">
      <PageTitle
        icon={Receipt}
        title="Money"
        subtitle={`${invoiceCount} ${invoiceCount === 1 ? 'invoice' : 'invoices'}`}
        actions={
          <>
            {overdueCount > 0 && (
              <button onClick={openChaser}
                className="flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2"
                title="AI-draft payment reminders for all overdue invoices">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                Chase overdue ({overdueCount})
              </button>
            )}
            {/* The one primary action on this view. */}
            <button onClick={openNew}
              className="flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700">
              <Plus className="h-3.5 w-3.5" /> New invoice
            </button>
          </>
        }
      />

      {/* Money band — the numbers that matter, above the fold. */}
      <MoneyKpis
        collected={totalRevenue}
        outstanding={outstanding}
        overdue={overdueTotal}
        overdueCount={overdueCount}
        aging={aging}
      />

      {/* Toolbar — search + status filter. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-44 rounded-lg border border-hairline bg-panel py-1.5 pl-8 pr-3 text-sm text-ink placeholder-ink-3 transition-colors focus:border-hairline focus:outline-hidden" />
        </div>

        <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-hairline bg-panel p-1">
          {STATUS_FILTERS.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors
                ${statusFilter === s ? 'bg-bg-2 text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2'}`}>
              {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
