import { useState } from 'react'
import { patch } from '../api'

/** Bulk-selection state + handlers for the Schedule page.
 *
 *  Returns:
 *    { selectedVisitIds, toggleVisitSelect, selectAllVisible,
 *      clearVisitSelection, bulkDeleteVisits, bulkDeleting }
 *
 *  "select all visible" toggles: if every visible row is already selected,
 *  it clears; otherwise it selects them all. `bulkDeleteVisits` cancels
 *  each visit (soft delete via PATCH status=cancelled) and drops them
 *  from the local `visits` list after a partial-success summary.
 *
 *  Takes `{ visits, setVisits, currentlyVisibleVisits, toast }` — the
 *  page owns the list; this hook mutates it via the passed setter. */
export function useVisitSelection({ visits, setVisits, currentlyVisibleVisits, toast }) {
  const [selectedVisitIds, setSelectedVisitIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const toggleVisitSelect = (id, e) => {
    e?.stopPropagation()
    setSelectedVisitIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selectAllVisible = () => {
    setSelectedVisitIds(prev => {
      const visibleIds = currentlyVisibleVisits.map(v => v.id)
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id))
      return allSelected ? new Set() : new Set(visibleIds)
    })
  }

  const clearVisitSelection = () => setSelectedVisitIds(new Set())

  const bulkDeleteVisits = async () => {
    const ids = Array.from(selectedVisitIds)
    if (ids.length === 0) return
    if (!confirm(`Cancel ${ids.length} visit${ids.length === 1 ? '' : 's'}? They will be marked cancelled (status=cancelled).`)) return
    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(
        ids.map(id => {
          const v = visits.find(x => x.id === id)
          const targetId = v?.job_id ?? id
          return patch(`/api/jobs/${targetId}`, { status: 'cancelled' })
        })
      )
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) toast.error(`Cancelled ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      setVisits(visits.filter(v => !selectedVisitIds.has(v.id)))
      clearVisitSelection()
    } catch (e) {
      toast.error('Bulk action failed: ' + (e?.message || 'unknown'))
    } finally {
      setBulkDeleting(false)
    }
  }

  return {
    selectedVisitIds,
    toggleVisitSelect,
    selectAllVisible,
    clearVisitSelection,
    bulkDeleteVisits,
    bulkDeleting,
  }
}
