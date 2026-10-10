import { Receipt, Plus, Search } from 'lucide-react'
import { PageTitle } from '../ui'
import { STATUS_FILTERS } from './constants'
import { MoneyKpis } from './MoneyKpis'
import { STATUS_DOT } from '../../theme/statusDots'

/** Page-level header for the Money page: a compact PageTitle (icon + title +
 *  invoice count + a "Chase overdue" secondary when anything is overdue + the
 *  single "New invoice" primary), the money band (Collected / Outstanding /
 *  Overdue + a compact AR-aging strip), and one calm command row (search + an
 *  always-visible neutral status segment).
 *
 *  The overdue *count* shows once — on the Overdue money tile — so "Chase
 *  overdue" is a plain labelled action, never a count bubble. The status segment
 *  is token-built (bg-bg-2 track / bg-panel active, matching the Clients
 *  toolbar), never a filled colored pill.
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
    <div className="space-y-3 px-4 pt-4 sm:px-8">
      <PageTitle
        icon={Receipt}
        title="Money"
        subtitle={`${invoiceCount} ${invoiceCount === 1 ? 'invoice' : 'invoices'}`}
        actions={
          <>
            {/* Secondary: AI-drafts reminders for every overdue invoice. No
                count here — the overdue count lives once, on the Overdue tile. */}
            {overdueCount > 0 && (
              <button onClick={openChaser}
                className="flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2"
                title="AI-draft payment reminders for all overdue invoices">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT.attention}`} aria-hidden="true" />
                Chase overdue
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

      {/* Money band — the numbers that matter, above the fold. The Overdue tile
          carries the Chase action; Collected / Overdue filter the list on tap. */}
      <MoneyKpis
        collected={totalRevenue}
        outstanding={outstanding}
        overdue={overdueTotal}
        overdueCount={overdueCount}
        aging={aging}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
      />

      {/* Command row — search + an always-visible status segment. */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative w-full sm:w-auto sm:flex-1 sm:min-w-[180px] sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search client or invoice #…"
            className="w-full rounded-lg border border-hairline bg-bg py-2 pl-9 pr-4 text-[13px] text-ink placeholder-ink-3 transition-colors focus:border-blue-400 focus:outline-hidden focus:ring-1 focus:ring-blue-400/20" />
        </div>

        {/* Status filter — always visible so the active tab is never ambiguous.
            Neutral segmented control (bg-bg-2 track / bg-panel active, no colored
            fills); scrolls horizontally at phone width. */}
        <div
          role="tablist"
          aria-label="Filter by status"
          className="flex w-full max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-bg-2 p-0.5 scrollbar-thin sm:w-auto">
          {STATUS_FILTERS.map(s => {
            const active = statusFilter === s
            const label = s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)
            return (
              <button key={s} role="tab" aria-selected={active}
                onClick={() => setStatusFilter(s)}
                className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                  active ? 'bg-panel text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2'
                }`}>
                {label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
