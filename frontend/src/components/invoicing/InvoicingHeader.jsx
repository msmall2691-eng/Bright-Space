import { Receipt, Plus, Search, Sparkles } from 'lucide-react'
import { PageHeader, StatCard } from '../ui'

const STATUS_FILTERS = ['', 'draft', 'sent', 'paid', 'overdue']

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
      {/* Page header */}
      <PageHeader
        icon={Receipt}
        iconColor="emerald"
        title="Invoices"
        subtitle={`${invoiceCount} total`}
        actions={
          <>
            {overdueCount > 0 && (
              <button onClick={openChaser}
                className="flex items-center gap-2 bg-amber-600 text-white hover:bg-amber-700 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors"
                title="AI-draft payment reminders for all overdue invoices">
                <Sparkles className="w-3.5 h-3.5" /> Chase overdue ({overdueCount})
              </button>
            )}
            <button onClick={openNew}
              className="flex items-center gap-2 bg-blue-600 text-white hover:bg-blue-700 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors">
              <Plus className="w-3.5 h-3.5" /> New invoice
            </button>
          </>
        }
      />

      {/* Metrics bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-hairline mx-4 sm:mx-8 mb-6 rounded-xl border border-hairline overflow-hidden">
        <StatCard className="bg-panel" label="Paid" value={`$${totalRevenue.toFixed(2)}`} accent="text-emerald-600" />
        <StatCard className="bg-panel" label="Outstanding" value={`$${outstanding.toFixed(2)}`} accent="text-amber-600" />
        <StatCard className="bg-panel" label="Invoices" value={invoiceCount} />
        <StatCard className="bg-panel" label="Overdue" value={overdueCount}
          accent={overdueCount > 0 ? 'text-red-600' : 'text-ink-3'} />
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
