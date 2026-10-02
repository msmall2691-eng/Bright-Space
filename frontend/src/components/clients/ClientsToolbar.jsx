import { useState } from 'react'
import { Plus, Search, Upload, LayoutGrid, TableProperties, SlidersHorizontal, ChevronDown } from 'lucide-react'
import SavedViewsBar from '../SavedViewsBar'
import ColumnsButton from '../ColumnsButton'

const STATUS_PILLS = [
  { key: '',         label: 'All' },
  { key: 'lead',     label: 'Leads' },
  { key: 'active',   label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
  // Archived = client lifecycle (archived_at set). Its own view, so an archived
  // client is findable to unarchive; no server count (derived client-side).
  { key: 'archived', label: 'Archived' },
]

/** Page-level toolbar for the Clients list. The primary row stays lean —
 *  search, the card/table toggle, and the New Client CTA — and the rest
 *  (saved views, status filter, columns, import) folds behind one quiet
 *  "Filters" disclosure, the same pattern Home uses so the page reads calm.
 *  A dot on the Filters button marks when a status filter is narrowing the
 *  list, so nothing hides silently. Fully controlled — the parent owns every
 *  piece of state; only the open/closed of the panel lives here. */
export function ClientsToolbar({
  search, setSearch,
  viewConfig, applyView,
  clientColumns, columns, setColumns,
  statusFilter, setStatusFilter, statusCounts,
  fileInputRef, importing, handleImport,
  viewMode, setViewMode,
  openNew,
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersActive = !!statusFilter

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative w-full sm:flex-1 sm:min-w-[180px] sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients..."
            className="w-full bg-bg border border-hairline rounded-lg pl-9 pr-4 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 transition-colors" />
        </div>

        <button onClick={() => setFiltersOpen(v => !v)} aria-expanded={filtersOpen}
          className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-hairline">
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Filters</span>
          {filtersActive && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" aria-hidden="true" />}
          <ChevronDown className={`w-3 h-3 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* View toggle (Twenty CRM-style) */}
        <div className="hidden sm:flex items-center bg-bg-2 rounded-lg p-0.5">
          <button onClick={() => setViewMode('cards')}
            className={`p-1.5 rounded-md transition-colors ${viewMode === 'cards' ? 'bg-panel shadow-xs text-ink-2' : 'text-ink-3 hover:text-ink-2'}`}
            title="Card view">
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setViewMode('table')}
            className={`p-1.5 rounded-md transition-colors ${viewMode === 'table' ? 'bg-panel shadow-xs text-ink-2' : 'text-ink-3 hover:text-ink-2'}`}
            title="Table view">
            <TableProperties className="w-3.5 h-3.5" />
          </button>
        </div>

        <button onClick={openNew}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
          <Plus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">New Client</span>
        </button>
      </div>

      <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleImport} />

      {filtersOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 sm:gap-3 rounded-xl border border-hairline bg-panel p-3">
          {/* Saved views switcher (Twenty-style) */}
          <SavedViewsBar entityType="client" currentConfig={viewConfig} onApply={applyView} defaultLabel="All clients" />

          {/* Status filter */}
          <div className="flex items-center gap-1 bg-bg-2 rounded-lg p-0.5">
            {STATUS_PILLS.map(s => (
              <button key={s.key} onClick={() => setStatusFilter(s.key)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                  statusFilter === s.key
                    ? 'bg-panel text-ink shadow-xs'
                    : 'text-ink-3 hover:text-ink-2'
                }`}>
                {s.label}
                {statusCounts[s.key] != null && (
                  <span className="ml-1.5 text-[10px] text-ink-3">{statusCounts[s.key]}</span>
                )}
              </button>
            ))}
          </div>

          {viewMode === 'table' && (
            <ColumnsButton columns={clientColumns} value={columns} onChange={setColumns} />
          )}

          <button onClick={() => fileInputRef.current?.click()} disabled={importing}
            className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 disabled:opacity-50 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-hairline">
            <Upload className="w-3.5 h-3.5" /> {importing ? 'Importing...' : 'Import'}
          </button>
        </div>
      )}
    </div>
  )
}
