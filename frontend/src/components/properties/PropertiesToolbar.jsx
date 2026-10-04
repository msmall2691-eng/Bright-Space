import { useState } from 'react'
import { Trash2, X, Plus, Search, RefreshCw, SlidersHorizontal, ChevronDown } from 'lucide-react'
import SavedViewsBar from '../SavedViewsBar'

// Type buckets shown in the segmented control — the synthetic "all" plus the
// three real property types. Counts come from usePropertyFilters.typeCounts.
const TYPE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'residential', label: 'Residential' },
  { key: 'commercial', label: 'Commercial' },
  { key: 'str', label: 'STR' },
]

/** Page-level command row for the Properties list — matches the Clients
 *  toolbar (#1041). One calm row: search, an always-visible type segmented
 *  control (counts + active state — the single source of truth, so the type
 *  count isn't shown twice and the active tab is never ambiguous), the Sync
 *  tools toggle (STR only), a quiet Filters disclosure for saved views, and
 *  the Add Property CTA. The type segment is a neutral token-built control
 *  (bg-bg-2 track, bg-panel on the active segment) — not a filled colored
 *  pill. Fully controlled; only the Filters open/closed lives here. */
export function PropertiesToolbar({
  search, setSearch,
  currentType, onTypeChange, typeCounts,
  hasStr, showAdvanced, setShowAdvanced,
  viewConfig, applyView,
  openNew,
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative w-full sm:w-auto sm:flex-1 sm:min-w-[180px] sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search properties..."
            className="w-full bg-bg border border-hairline rounded-lg pl-9 pr-4 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 transition-colors" />
        </div>

        {/* Type filter — always visible so the active tab is never ambiguous
            and the type count lives in exactly one place. Neutral segmented
            control (no colored fills); scrolls horizontally at phone width. */}
        <div
          role="tablist"
          aria-label="Filter by property type"
          className="flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5 overflow-x-auto scrollbar-thin w-full sm:w-auto max-w-full">
          {TYPE_TABS.map(t => {
            const active = currentType === t.key
            return (
              <button key={t.key} role="tab" aria-selected={active}
                onClick={() => onTypeChange(t.key)}
                className={`shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                  active ? 'bg-panel text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2'
                }`}>
                {t.label}
                {typeCounts?.[t.key] != null && (
                  <span className="ml-1.5 text-[10px] text-ink-3 tabular-nums">{typeCounts[t.key]}</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 ml-auto">
          {hasStr && (
            <button onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced}
              title="Sync tools and turnover health check"
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border ${
                showAdvanced
                  ? 'bg-panel border-hairline-2 text-ink'
                  : 'bg-bg-2 border-hairline text-ink-2 hover:text-ink'
              }`}>
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sync tools</span>
            </button>
          )}

          <button onClick={() => setFiltersOpen(v => !v)} aria-expanded={filtersOpen}
            className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-hairline">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Filters</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
          </button>

          <button onClick={openNew}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
            <Plus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Add Property</span>
          </button>
        </div>
      </div>

      {filtersOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 sm:gap-3 rounded-xl border border-hairline bg-panel p-3">
          {/* Saved views switcher (secondary — out of the main row to match Clients). */}
          <SavedViewsBar entityType="property" currentConfig={viewConfig} onApply={applyView} defaultLabel="All properties" />
        </div>
      )}
    </div>
  )
}

/** Selection + bulk action row above the property list.
 *  Left: "Select all (N)" checkbox. Right (when any row is selected):
 *  N selected · Hard delete toggle · Clear · Deactivate/Delete button. */
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
              ? (hardDelete ? 'Deleting...' : 'Deactivating...')
              : `${hardDelete ? 'Hard delete' : 'Deactivate'} ${selectedIds.size}`}
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
    <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-panel px-3 py-2 mb-4 text-[12.5px]">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${syncResult.ok ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden="true" />
      <span className="flex-1 text-ink">
        {syncResult.ok
          ? `Sync complete — ${syncResult.jobs_created ?? syncResult.results?.reduce((s, r) => s + (r.jobs_created || 0), 0) ?? 0} new turnover job(s) created`
          : `Sync failed: ${syncResult.error || syncResult.detail}`}
      </span>
      <button onClick={onDismiss} className="text-ink-3 hover:text-ink-2 shrink-0"><X className="w-3.5 h-3.5" /></button>
    </div>
  )
}
