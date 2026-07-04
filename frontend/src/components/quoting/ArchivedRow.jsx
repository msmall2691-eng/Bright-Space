import { Trash2 } from 'lucide-react'

/** A row on the Archived tab (soft-deleted quotes). Renders with a
 *  permanent-delete button when the viewer is an admin. */
export default function ArchivedRow({
  q,
  isAdmin,
  clientName,
  selectedIds,
  onToggleSelect,
  onOpenQuote,
  onDeletePermanent,
}) {
  return (
    <div className="bg-panel border border-hairline rounded-xl p-4">
      <div className="flex items-center gap-3">
        {isAdmin && (
          <input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => onToggleSelect(q.id)}
            className="w-4 h-4 shrink-0 rounded border-hairline accent-red-600 cursor-pointer"
            title="Select for permanent delete" />
        )}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpenQuote(q)}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{clientName(q.client_id)}</span>
            <span className="text-xs text-ink-3">{q.quote_number}</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full border bg-bg-2 text-ink-3 border-hairline">archived</span>
          </div>
          <div className="text-xs text-ink-3 mt-0.5">
            {[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), q.address,
              q.archived_at && `archived ${new Date(q.archived_at).toLocaleDateString()}`].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
        {isAdmin && (
          <button onClick={() => onDeletePermanent(q)}
            title="Delete permanently"
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        )}
      </div>
    </div>
  )
}
