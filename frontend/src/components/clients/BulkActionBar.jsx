import { Trash2, Users } from 'lucide-react'

/** Row above the client list showing the "Select all" checkbox, the total
 *  filtered count, and — when rows are selected — the merge / delete
 *  bulk actions. Fully controlled: parent owns the selection set and
 *  the mutation handlers. Renders in both card and table views. */
export function BulkActionBar({
  filtered,
  selectedIds,
  toggleSelectAll,
  clearSelection,
  openMerge,
  bulkDelete,
  bulkDeleting,
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-3 text-[11px] text-ink-3 font-medium">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={filtered.length > 0 && filtered.every(c => selectedIds.has(c.id))}
            onChange={toggleSelectAll}
            className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
            data-testid="clients-select-all"
          />
          <span>Select all</span>
        </label>
        <span>{filtered.length} client{filtered.length !== 1 ? 's' : ''}</span>
      </div>
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2" data-testid="clients-bulk-actions">
          <span className="text-[11px] text-ink-2 font-medium">{selectedIds.size} selected</span>
          <button onClick={clearSelection}
            className="text-[11px] text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
            Clear
          </button>
          {selectedIds.size === 2 && (
            <button onClick={openMerge}
              data-testid="clients-bulk-merge"
              className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-3 border border-hairline text-ink-2 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors">
              <Users className="w-3.5 h-3.5" />
              Merge
            </button>
          )}
          <button onClick={bulkDelete} disabled={bulkDeleting}
            data-testid="clients-bulk-delete"
            className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
            {bulkDeleting ? 'Deleting...' : `Delete ${selectedIds.size}`}
          </button>
        </div>
      )}
    </div>
  )
}
