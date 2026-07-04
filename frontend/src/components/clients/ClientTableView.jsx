import { Users } from 'lucide-react'
import { EmptyState } from '../ui'

/** Table view (Twenty CRM-inspired) for the clients list. Renders the
 *  sticky header with per-column labels, a selection column, and each
 *  visible column's `render(c, {updateStatus, setJobClient})`. Falls
 *  back to a shared EmptyState when the filter matches zero rows. */
export function ClientTableView({
  filtered,
  visibleColumns,
  selectedIds,
  toggleSelect,
  toggleSelectAll,
  updateStatus,
  setJobClient,
  navigate,
  search,
  statusFilter,
  openNew,
}) {
  return (
    <div className="overflow-auto flex-1 border border-hairline rounded-xl bg-panel">
      <table className="w-full text-left">
        <thead className="sticky top-0 bg-bg z-10">
          <tr className="border-b border-hairline">
            <th className="px-3 py-2.5 w-8">
              <input
                type="checkbox"
                checked={filtered.length > 0 && filtered.every(c => selectedIds.has(c.id))}
                onChange={toggleSelectAll}
                className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
                aria-label="Select all rows"
              />
            </th>
            {visibleColumns.map(col => (
              <th key={col.id} className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider px-4 py-2.5">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map(c => (
            <tr key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
              className={`border-b border-hairline cursor-pointer transition-colors ${selectedIds.has(c.id) ? 'bg-bg-2' : 'hover:bg-bg-2/60'}`}>
              <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={(e) => toggleSelect(c.id, e)}
                  className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
                  aria-label={`Select ${c.name}`}
                />
              </td>
              {visibleColumns.map(col => (
                <td key={col.id} className="px-4 py-2.5">{col.render(c, { updateStatus, setJobClient })}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && (
        <EmptyState icon={Users} title={search || statusFilter ? 'No matching clients' : 'No clients yet'}
          description={search || statusFilter ? 'Try a different search or filter.' : undefined}
          action={!search && !statusFilter && (
            <button onClick={openNew} className="text-xs font-semibold text-blue-600 hover:text-blue-700">Add your first client →</button>
          )} />
      )}
    </div>
  )
}
