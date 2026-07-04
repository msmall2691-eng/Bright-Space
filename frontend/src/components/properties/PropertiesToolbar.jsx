import { AlertCircle, CheckCircle, ChevronRight, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import SavedViewsBar from '../SavedViewsBar'
import { PROPERTY_TYPE_CONFIG } from './constants'

const PAGE_TITLES = {
  all: 'All Properties',
  residential: 'Residential Properties',
  commercial: 'Commercial Properties',
  str: 'STR Properties',
}

const TYPE_TABS = ['all', 'residential', 'commercial', 'str']

/** Top strip of the Properties page: page title + search box + Saved
 *  views bar + Sync-tools toggle (STR only) + "+ Add Property" button,
 *  plus the type tabs (All / Residential / Commercial / STR) with counts.
 *
 *  Pure presentational. */
export function PropertiesToolbar({
  currentType,
  search, setSearch,
  viewConfig, applyView,
  typeCounts,
  showAdvanced, setShowAdvanced,
  onAddNew,
  setSearchParams,
}) {
  const pageTitle = PAGE_TITLES[currentType]
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-ink tracking-tight">{pageTitle}</h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search properties…"
              className="bg-bg-2 border border-hairline rounded-lg pl-8 pr-3 py-2 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 w-40 sm:w-52" />
          </div>
          <SavedViewsBar entityType="property" currentConfig={viewConfig} onApply={applyView} defaultLabel="All properties" />
          {typeCounts.str > 0 && (
            <button onClick={() => setShowAdvanced(v => !v)}
              title="Sync tools and turnover health check"
              className={`flex items-center gap-2 border border-hairline px-4 py-2 rounded-lg text-sm transition-colors ${showAdvanced ? 'bg-bg-2 text-ink' : 'bg-panel hover:bg-bg-2 text-ink-2'}`}>
              <RefreshCw className="w-3.5 h-3.5" />
              Sync tools
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
            </button>
          )}
          <button onClick={onAddNew}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> Add Property
          </button>
        </div>
      </div>

      {/* Type tabs */}
      <div className="flex gap-2 mb-5 border-b border-hairline">
        {TYPE_TABS.map(type => (
          <button
            key={type}
            onClick={() => setSearchParams({ type: type === 'all' ? '' : type })}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              currentType === type
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-ink-2 hover:text-ink'
            }`}
          >
            {type === 'all' ? `All (${typeCounts.all})` : `${PROPERTY_TYPE_CONFIG[type].label} (${typeCounts[type]})`}
          </button>
        ))}
      </div>
    </>
  )
}

/** Selection + bulk action row above the property list.
 *  Left: "Select all (N)" checkbox. Right (when any row is selected):
 *  N selected · Hard delete toggle · Clear · Archive/Delete button. */
export function BulkActionBar({
  filteredProperties,
  selectedIds, toggleSelectAll, clearSelection,
  hardDelete, setHardDelete,
  bulkDelete, bulkDeleting,
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <label className="flex items-center gap-2 text-xs text-ink-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={filteredProperties.length > 0 && filteredProperties.every(p => selectedIds.has(p.id))}
          onChange={toggleSelectAll}
          className="w-4 h-4 rounded border-hairline cursor-pointer"
          data-testid="properties-select-all"
        />
        <span>Select all ({filteredProperties.length})</span>
      </label>
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2" data-testid="properties-bulk-actions">
          <span className="text-xs text-ink-2 font-medium">{selectedIds.size} selected</span>
          <label className="flex items-center gap-1 text-[11px] text-ink-2 cursor-pointer select-none" title="Permanently remove from database (vs. soft-archive)">
            <input type="checkbox" checked={hardDelete}
              onChange={e => setHardDelete(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-hairline cursor-pointer" />
            Hard delete
          </label>
          <button onClick={clearSelection}
            className="text-xs text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
            Clear
          </button>
          <button onClick={bulkDelete} disabled={bulkDeleting}
            data-testid="properties-bulk-delete"
            className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
            {bulkDeleting
              ? 'Deleting...'
              : `${hardDelete ? 'Hard delete' : 'Archive'} ${selectedIds.size}`}
          </button>
        </div>
      )}
    </div>
  )
}

/** Green (ok) or red (failed) sync-result banner shown after per-property
 *  sync or "Sync all feeds" completes. Aggregates jobs_created across all
 *  results when the payload doesn't include a top-level count. */
export function SyncResultBanner({ syncResult, onDismiss }) {
  return (
    <div className={`flex items-start gap-2 rounded-xl p-4 mb-4 text-sm border ${syncResult.ok ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
      {syncResult.ok
        ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
        : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
      <div>
        {syncResult.ok
          ? `Sync complete — ${syncResult.jobs_created ?? syncResult.results?.reduce((s, r) => s + (r.jobs_created || 0), 0) ?? 0} new turnover job(s) created`
          : `Sync failed: ${syncResult.error || syncResult.detail}`}
      </div>
      <button onClick={onDismiss} className="ml-auto opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
    </div>
  )
}
