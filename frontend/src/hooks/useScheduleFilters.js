import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { todayYMD } from '../utils/format'

// Persisted across sessions (Tier 4 roadmap: "saved views / filters ...
// persisted in localStorage") — just the two standing "how I like to view
// my schedule" chips. unassignedOnly/noGcalOnly/noConnecteamOnly are
// deliberately NOT persisted: those are one-shot "jump to the problem list"
// actions (triggered from a dashboard follow-up or a health-strip counter),
// not a durable preference — silently reapplying one of those on a later
// visit would read as "why is my schedule filtered?" rather than a saved view.
const FILTER_KEY = 'brightbase_schedule_filters'

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

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
  const [selectedPropertyType, setSelectedPropertyType] = useState(() => loadSavedFilters().propertyType || 'all')
  const [selectedStatus, setSelectedStatus] = useState(() => loadSavedFilters().status || 'all')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  // "no-Google" / "no-Connecteam" quick filters — driven both by a URL
  // param (deep links from the dashboard's follow-up cards) and by the
  // clickable counters in ScheduleHealthStrip. Audit finding: those
  // counters were dead numbers; now they narrow the list to the offenders.
  const [noGcalOnly, setNoGcalOnly] = useState(false)
  const [noConnecteamOnly, setNoConnecteamOnly] = useState(false)

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({
      propertyType: selectedPropertyType,
      status: selectedStatus,
    }))
  }, [selectedPropertyType, selectedStatus])

  // One-shot sync from URL ?filter=unassigned|no_gcal|no_connecteam so a
  // click on a dashboard follow-up lands the operator on the queue with the
  // filter pre-applied. Runs once on mount; user tweaks after that stick.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const f = (searchParams.get('filter') || '').toLowerCase()
    if (!f) return
    if (f === 'unassigned') setUnassignedOnly(true)
    else if (f === 'no_gcal') setNoGcalOnly(true)
    else if (f === 'no_connecteam') setNoConnecteamOnly(true)
    // Strip the param so a later refresh doesn't re-fire the initial state.
    const next = new URLSearchParams(searchParams)
    next.delete('filter')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        // "Not on Google" / "Not in Connecteam" — only against active
        // visits, and gcal_event_id resolves through the linked job (the
        // id lives on Job, not Visit, same as scheduleStats above).
        if ((noGcalOnly || noConnecteamOnly) && (v.status === 'cancelled' || v.status === 'completed')) return false
        if (noGcalOnly) {
          const onGcal = !!(v.gcal_event_id || jobs[v.job_id]?.gcal_event_id)
          if (onGcal) return false
        }
        if (noConnecteamOnly) {
          const onCt = ((jobs[v.job_id]?.connecteam_shift_ids || []).length || 0) > 0
          if (onCt) return false
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
        // scheduled_date is ISO (YYYY-MM-DD) and start_time is HH:MM — both
        // sort lexicographically in chronological order, so compare the strings
        // directly instead of allocating two Date objects per comparison
        // (O(n log n) Dates on every filter/visits change was pure GC churn).
        const aKey = `${a.scheduled_date}T${(a.start_time || '09:00').padStart(5, '0')}`
        const bKey = `${b.scheduled_date}T${(b.start_time || '09:00').padStart(5, '0')}`
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
      })
  }, [visits, selectedPropertyType, selectedStatus, unassignedOnly, noGcalOnly, noConnecteamOnly, jobs, properties])

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
    const todayStr = todayYMD()
    const active = (visits || []).filter(v => v.status !== 'cancelled')
    // The Google event id lives on the Job, not the Visit, so resolve through the
    // linked job — otherwise every visit reads as "not on Google" (false 0/total).
    const onGcal = (v) => !!(v.gcal_event_id || jobs[v.job_id]?.gcal_event_id)
    const gcal = active.filter(onGcal).length
    const connecteam = active.filter(v => (jobs[v.job_id]?.connecteam_shift_ids || []).length > 0).length
    // Split the "not in Connecteam" total by root cause. The Connecteam
    // dispatcher skips any job with no cleaner_ids (see scheduling/router.py),
    // so "not in Connecteam" conflates two very different states:
    //   - assigned but not yet pushed (a real sync gap — the fixer resolves this)
    //   - no cleaner yet (nothing to push — the operator has to assign first)
    // Reporting them as one number sends the operator to "Fix sync now" when
    // the actual fix is to assign a cleaner.
    const needsCleaner = active.filter(v => {
      const hasCt = (jobs[v.job_id]?.connecteam_shift_ids || []).length > 0
      if (hasCt) return false
      const assigned = (v.cleaner_ids?.length || 0) > 0
      return !assigned
    }).length
    const assignedNotPushed = active.filter(v => {
      const hasCt = (jobs[v.job_id]?.connecteam_shift_ids || []).length > 0
      if (hasCt) return false
      const assigned = (v.cleaner_ids?.length || 0) > 0
      return assigned
    }).length
    return {
      today: active.filter(v => v.scheduled_date === todayStr).length,
      week: active.length,
      gcal, connecteam, total: active.length,
      notGcal: active.length - gcal,
      notConnecteam: active.length - connecteam,
      needsCleaner,
      assignedNotPushed,
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
    noGcalOnly, setNoGcalOnly,
    noConnecteamOnly, setNoConnecteamOnly,
    filteredVisits, unassignedCount, visitsByDate, scheduleStats,
    currentlyVisibleVisits,
  }
}
