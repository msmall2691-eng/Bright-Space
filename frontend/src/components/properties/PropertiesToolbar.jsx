import { AlertCircle, CheckCircle, Trash2, X } from 'lucide-react'

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
