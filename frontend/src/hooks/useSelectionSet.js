import { useCallback, useState } from 'react'

/** Generic multi-select Set for a list of items. Used by the Properties
 *  page's bulk-action bar; kept generic here so other list pages can
 *  reuse it later.
 *
 *  toggle(id, e): flip a single row (stops event propagation so a
 *    checkbox click inside a clickable card doesn't also expand the
 *    row).
 *  toggleAll(visibleIds): if all visible rows are already selected,
 *    clear; otherwise select exactly the visible rows (drops any
 *    non-visible ids so `Select all` on a filtered view is intuitive).
 *  clear(): drop everything. */
export function useSelectionSet() {
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  const toggle = useCallback((id, e) => {
    e?.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback((visibleIds) => {
    setSelectedIds(prev => {
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id))
      return allSelected ? new Set() : new Set(visibleIds)
    })
  }, [])

  const clear = useCallback(() => setSelectedIds(new Set()), [])

  return { selectedIds, toggle, toggleAll, clear }
}
