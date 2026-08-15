import { Users } from 'lucide-react'
import { EmptyState } from '../ui'

/** Table view for the clients list — the app's archetype list table
 *  (Attio/Twenty-grade, shared .bb-table vocabulary from index.css):
 *  compact 36px rows, sentence-case quiet column labels, full-row hover,
 *  selection column, and a summary footer. Falls back to a shared
 *  EmptyState when the filter matches zero rows. */
export function ClientTableView({
  filtered,
  visibleColumns,
  selectedIds,
  toggleSelect,
  toggleSelectAll,
  updateStatus,
  setJobClient,
  navigate,
  onRowOpen,
  peekId,
  search,
  statusFilter,
  openNew,
}) {
  // Row click peeks (side panel) when the page provides onRowOpen; falls
  // back to the old full navigation otherwise.
  const openRow = onRowOpen || ((c) => navigate(`/clients/${c.id}`))
  return (
    <div className="overflow-auto flex-1 border border-hairline rounded-lg bg-panel flex flex-col">
      <div className="flex-1 overflow-auto">
      <table className="bb-table">
        <thead className="sticky top-0 bg-panel z-10">
          <tr>
            <th className="bb-th w-8 !px-3">
              <input
                type="checkbox"
                checked={filtered.length > 0 && filtered.every(c => selectedIds.has(c.id))}
                onChange={toggleSelectAll}
                className="bb-check block"
                aria-label="Select all rows"
              />
            </th>
            {visibleColumns.map(col => (
              <th key={col.id} className="bb-th">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map(c => (
            <tr key={c.id} onClick={() => openRow(c)}
              className={`bb-row ${selectedIds.has(c.id) || peekId === c.id ? 'bb-row-selected' : ''}`}>
              <td className="bb-td !px-3" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={(e) => toggleSelect(c.id, e)}
                  className="bb-check block"
                  aria-label={`Select ${c.name}`}
                />
              </td>
              {visibleColumns.map((col, i) => (
                <td key={col.id} className={`bb-td ${i === 0 ? 'bb-td-primary' : ''}`}>
                  {col.render(c, { updateStatus, setJobClient })}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && (
        <EmptyState icon={Users} title={search || statusFilter ? 'No matching clients' : 'No clients yet'}
          description={search || statusFilter ? 'Try a different search or filter.' : undefined}
          action={!search && !statusFilter && (
            <button onClick={openNew} className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">Add your first client →</button>
          )} />
      )}
      </div>
      {filtered.length > 0 && (
        <div className="bb-table-foot shrink-0">
          <span className="tabular-nums">{filtered.length} {filtered.length === 1 ? 'client' : 'clients'}</span>
          {selectedIds.size > 0 && <span className="tabular-nums">{selectedIds.size} selected</span>}
        </div>
      )}
    </div>
  )
}
