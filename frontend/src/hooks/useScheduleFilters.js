import { useMemo, useState } from 'react'

/** Derived views over the week's visits: filter chip state (property type
 *  + status + unassigned-only) + the four cascading useMemos every render
 *  branch uses.
 *
 *  Returns:
 *    { selectedPropertyType, setSelectedPropertyType,
 *      selectedStatus, setSelectedStatus,
 *      unassignedOnly, setUnassignedOnly,
 *      filteredVisits, unassignedCount, visitsByDate, scheduleStats,
 *      currentlyVisibleVisits }
 *
 *  `currentlyVisibleVisits` narrows to the current day in agenda mode so
 *  "select all visible" can't reach hidden days (a P1 fix from earlier). */
export function useScheduleFilters({ visits, jobs, properties, viewMode, dateStr }) {
  const [selectedPropertyType, setSelectedPropertyType] = useState('all')
  const [selectedStatus, setSelectedStatus] = useState('all')
  const [unassignedOnly, setUnassignedOnly] = useState(false)

  const filteredVisits = useMemo(() => {
    if (!visits || visits.length === 0) return []
    return visits
      .filter(v => {
        if (selectedStatus === 'all') {
          // 'all' means all active — hide cancelled (see them via the Cancelled option)
          if (v.status === 'cancelled') return false
        } else if (v.status !== selectedStatus) {
          return false
        }
        if (selectedPropertyType !== 'all') {
          const job = jobs[v.job_id]
          const prop = properties[job?.property_id]
          if (prop?.property_type !== selectedPropertyType) return false
        }
        // "Needs assignment" filter: no cleaners on an active visit.
        if (unassignedOnly) {
          const unassigned = (v.cleaner_ids?.length || 0) === 0 &&
            v.status !== 'completed' && v.status !== 'cancelled'
          if (!unassigned) return false
        }
        return true
      })
      .sort((a, b) => {
        // Null/empty dates sort last (Unscheduled bucket).
        const aHasDate = !!(a.scheduled_date && String(a.scheduled_date).trim())
        const bHasDate = !!(b.scheduled_date && String(b.scheduled_date).trim())
        if (!aHasDate && !bHasDate) return 0
        if (!aHasDate) return 1
        if (!bHasDate) return -1
        const aDate = new Date(`${a.scheduled_date}T${a.start_time || '09:00'}`)
        const bDate = new Date(`${b.scheduled_date}T${b.start_time || '09:00'}`)
        return aDate - bDate
      })
  }, [visits, selectedPropertyType, selectedStatus, unassignedOnly, jobs, properties])

  const unassignedCount = useMemo(() => (
    (visits || []).filter(v => (v.cleaner_ids?.length || 0) === 0 &&
      v.status !== 'completed' && v.status !== 'cancelled').length
  ), [visits])

  const visitsByDate = useMemo(() => {
    const grouped = {}
    filteredVisits.forEach(v => {
      const key = (v.scheduled_date && String(v.scheduled_date).trim()) ? v.scheduled_date : 'unscheduled'
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(v)
    })
    return grouped
  }, [filteredVisits])

  const scheduleStats = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0]
    const active = (visits || []).filter(v => v.status !== 'cancelled')
    // The Google event id lives on the Job, not the Visit, so resolve through the
    // linked job — otherwise every visit reads as "not on Google" (false 0/total).
    const onGcal = (v) => !!(v.gcal_event_id || jobs[v.job_id]?.gcal_event_id)
    const gcal = active.filter(onGcal).length
    const connecteam = active.filter(v => (jobs[v.job_id]?.connecteam_shift_ids || []).length > 0).length
    return {
      today: active.filter(v => v.scheduled_date === todayStr).length,
      week: active.length,
      gcal, connecteam, total: active.length,
      notGcal: active.length - gcal,
      notConnecteam: active.length - connecteam,
    }
  }, [visits, jobs])

  // In agenda mode, "visible" is the current day only — bulk-cancel from
  // agenda must not reach hidden days.
  const currentlyVisibleVisits = useMemo(() => {
    if (viewMode === 'agenda') {
      return filteredVisits.filter(v => v.scheduled_date === dateStr)
    }
    return filteredVisits
  }, [viewMode, filteredVisits, dateStr])

  return {
    selectedPropertyType, setSelectedPropertyType,
    selectedStatus, setSelectedStatus,
    unassignedOnly, setUnassignedOnly,
    filteredVisits, unassignedCount, visitsByDate, scheduleStats,
    currentlyVisibleVisits,
  }
}
