import { Plus, Search, Upload, LayoutGrid, TableProperties } from 'lucide-react'
import SavedViewsBar from '../SavedViewsBar'
import ColumnsButton from '../ColumnsButton'

const STATUS_PILLS = [
  { key: '',         label: 'All' },
  { key: 'lead',     label: 'Leads' },
  { key: 'active',   label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
]

/** Page-level toolbar for the Clients list: search input, saved-views
 *  switcher, columns picker (table view only), status pills, XLSX/CSV
 *  import trigger, card/table view toggle, and the New Client CTA.
 *  Fully controlled — the parent owns every piece of state. */
export function ClientsToolbar({
  search, setSearch,
  viewConfig, applyView,
  clientColumns, columns, setColumns,
  statusFilter, setStatusFilter, statusCounts,
  fileInputRef, importing, handleImport,
  viewMode, setViewMode,
  openNew,
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <div className="relative flex-1 min-w-[180px] max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients..."
          className="w-full bg-bg border border-hairline rounded-lg pl-9 pr-4 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 transition-colors" />
      </div>

      {/* Saved views switcher (Twenty-style) */}
      <SavedViewsBar entityType="client" currentConfig={viewConfig} onApply={applyView} defaultLabel="All clients" />
      {viewMode === 'table' && (
        <ColumnsButton columns={clientColumns} value={columns} onChange={setColumns} />
      )}

      {/* Status pills */}
      <div className="flex items-center gap-1 bg-bg-2 rounded-lg p-0.5">
        {STATUS_PILLS.map(s => (
          <button key={s.key} onClick={() => setStatusFilter(s.key)}
            className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
              statusFilter === s.key
                ? 'bg-panel text-ink shadow-sm'
                : 'text-ink-3 hover:text-ink-2'
            }`}>
            {s.label}
            <span className="ml-1.5 text-[10px] text-ink-3">{statusCounts[s.key]}</span>
          </button>
        ))}
      </div>

      <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleImport} />
      <button onClick={() => fileInputRef.current?.click()} disabled={importing}
        className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 disabled:opacity-50 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-hairline">
        <Upload className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{importing ? 'Importing...' : 'Import'}</span>
      </button>
      {/* View toggle (Twenty CRM-style) */}
      <div className="hidden sm:flex items-center bg-bg-2 rounded-lg p-0.5">
        <button onClick={() => setViewMode('cards')}
          className={`p-1.5 rounded-md transition-colors ${viewMode === 'cards' ? 'bg-panel shadow-sm text-ink-2' : 'text-ink-3 hover:text-ink-2'}`}
          title="Card view">
          <LayoutGrid className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => setViewMode('table')}
          className={`p-1.5 rounded-md transition-colors ${viewMode === 'table' ? 'bg-panel shadow-sm text-ink-2' : 'text-ink-3 hover:text-ink-2'}`}
          title="Table view">
          <TableProperties className="w-3.5 h-3.5" />
        </button>
      </div>

      <button onClick={openNew}
        className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
        <Plus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">New Client</span>
      </button>
    </div>
  )
}
