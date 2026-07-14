import { useState } from 'react'
import { patch, post } from '../api'
import { confirmDialog } from '../utils/confirmBus'

/** Bulk-selection state + handlers for the Schedule page.
 *
 *  Returns:
 *    { selectedVisitIds, toggleVisitSelect, selectAllVisible,
 *      clearVisitSelection, bulkDeleteVisits, bulkDeleting,
 *      bulkShiftVisits, bulkShifting }
 *
 *  "select all visible" toggles: if every visible row is already selected,
 *  it clears; otherwise it selects them all. `bulkDeleteVisits` cancels
 *  each visit (soft delete via PATCH status=cancelled) and drops them
 *  from the local `visits` list after a partial-success summary.
 *  `bulkShiftVisits` ("weather day" move) shifts every selected visit's
 *  date by N days in one backend call — recurring-aware server-side, so a
 *  shifted occurrence doesn't get regenerated back at its old date.
 *
 *  Takes `{ visits, setVisits, currentlyVisibleVisits, toast }` — the
 *  page owns the list; this hook mutates it via the passed setter. */
export function useVisitSelection({ visits, setVisits, currentlyVisibleVisits, toast, onAfterShift }) {
  const [selectedVisitIds, setSelectedVisitIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkShifting, setBulkShifting] = useState(false)

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
    if (!(await confirmDialog(`Cancel ${ids.length} visit${ids.length === 1 ? '' : 's'}? They will be marked cancelled (status=cancelled).`, { confirmLabel: 'Cancel visits', danger: true }))) return
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

  const bulkShiftVisits = async (shiftDays) => {
    const ids = Array.from(selectedVisitIds)
    if (ids.length === 0 || !shiftDays) return
    const dayWord = Math.abs(shiftDays) === 1 ? 'day' : 'days'
    const dir = shiftDays > 0 ? `forward ${shiftDays} ${dayWord}` : `back ${Math.abs(shiftDays)} ${dayWord}`
    if (!(await confirmDialog(`Shift ${ids.length} visit${ids.length === 1 ? '' : 's'} ${dir}?`, { confirmLabel: 'Shift' }))) return
    setBulkShifting(true)
    try {
      const jobIds = ids.map(id => {
        const v = visits.find(x => x.id === id)
        return v?.job_id ?? id
      })
      const res = await post('/api/jobs/bulk-reschedule', { job_ids: jobIds, shift_days: shiftDays })
      if (res.skipped?.length > 0) {
        toast.error(`Shifted ${res.shifted} of ${ids.length}. ${res.skipped.length} couldn't move (cancelled/completed).`)
      } else {
        toast.success(`Shifted ${res.shifted} visit${res.shifted === 1 ? '' : 's'} ${dir}`)
      }
      // These visits no longer belong on this agenda day — drop them locally
      // and let the caller refresh whatever else depends on the date range
      // (month grid, week view) rather than refetching here.
      setVisits(visits.filter(v => !selectedVisitIds.has(v.id)))
      clearVisitSelection()
      onAfterShift?.()
    } catch (e) {
      toast.error('Bulk shift failed: ' + (e?.message || 'unknown'))
    } finally {
      setBulkShifting(false)
    }
  }

  return {
    selectedVisitIds,
    toggleVisitSelect,
    selectAllVisible,
    clearVisitSelection,
    bulkDeleteVisits,
    bulkShiftVisits,
    bulkShifting,
    bulkDeleting,
  }
}
