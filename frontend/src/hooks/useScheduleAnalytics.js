import { useMemo } from 'react'
import { toLocalYMD, todayYMD } from '../utils/format'

/**
 * Derived analytics over the loaded week — everything the redesigned
 * dispatch UI (hero chips, route ribbon, date strip, crew utilization)
 * needs to render without a second API round-trip.
 *
 * The rest of the schedule already has useScheduleFilters, which owns
 * the filter chip state + the health-strip totals. This hook is purely
 * about *shape* (per-day load, per-crew load, ops summary for the
 * selected day) — no filter state, no selection state. Keeping them
 * separate stops the analytics from re-firing every time an operator
 * toggles a filter chip.
 */

// Rough capacity floor: one crew, 8 productive hours per day. The real
// number depends on cleaner shifts + PTO; we treat it as an approximation
// good enough for a "how packed am I" bar. Overridable if the settings
// page ever exposes a per-crew shift-length setting.
const HOURS_PER_CREW_DAY = 8

const hoursBetween = (startHHMM, endHHMM) => {
  if (!startHHMM || !endHHMM) return 0
  const [sh, sm] = String(startHHMM).slice(0, 5).split(':').map(Number)
  const [eh, em] = String(endHHMM).slice(0, 5).split(':').map(Number)
  if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return 0
  return Math.max(0, (eh + em / 60) - (sh + sm / 60))
}

const isActive = (v) => v && v.status !== 'cancelled' && !!v.scheduled_date

const isUnassigned = (v) =>
  isActive(v) && v.status !== 'completed' && (v.cleaner_ids?.length || 0) === 0

export function useScheduleAnalytics({ visits, jobs, currentDate, employees }) {
  const dateStr = toLocalYMD(currentDate)

  // The seven-day strip centered on the week that contains `currentDate`
  // — Sunday first to match US calendar convention. Independent of the
  // useScheduleData range so we can render 7 chips even if the fetch was
  // month-wide (the parent uses the same range for its month grid).
  const weekDates = useMemo(() => {
    const start = new Date(currentDate)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - start.getDay()) // back to Sunday
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return toLocalYMD(d)
    })
  }, [currentDate])

  const activeVisits = useMemo(
    () => (visits || []).filter(isActive),
    [visits],
  )

  // Per-day load for the 7-day date strip. jobs = count, hours = summed
  // duration, capacityPct = hours / (crews × 8h). Crew count defaults to
  // 3 when the Connecteam roster is empty so the strip isn't 100% flat.
  const loadByDate = useMemo(() => {
    const crewCount = Math.max(3, employees?.length || 0)
    const dayCap = crewCount * HOURS_PER_CREW_DAY
    const map = {}
    weekDates.forEach(d => (map[d] = { jobs: 0, hours: 0, capacityPct: 0 }))
    activeVisits.forEach(v => {
      const bucket = map[v.scheduled_date]
      if (!bucket) return
      bucket.jobs += 1
      bucket.hours += hoursBetween(v.start_time, v.end_time)
    })
    weekDates.forEach(d => {
      const row = map[d]
      row.capacityPct = Math.min(100, Math.round((row.hours / dayCap) * 100))
    })
    return map
  }, [activeVisits, weekDates, employees])

  // Today's ops summary — one number per chip on the hero.
  const todayVisits = useMemo(
    () => activeVisits.filter(v => v.scheduled_date === dateStr),
    [activeVisits, dateStr],
  )

  const todayStats = useMemo(() => {
    const jobsCount = todayVisits.length
    const unassigned = todayVisits.filter(isUnassigned).length
    const crewIds = new Set()
    let hours = 0
    todayVisits.forEach(v => {
      hours += hoursBetween(v.start_time, v.end_time)
      ;(v.cleaner_ids || []).forEach(id => crewIds.add(id))
    })
    const crewCount = Math.max(3, employees?.length || 0)
    const capacity = crewCount * HOURS_PER_CREW_DAY
    const capacityPct = capacity ? Math.min(100, Math.round((hours / capacity) * 100)) : 0
    return {
      jobs: jobsCount,
      unassigned,
      capacityPct,
      crewsOut: crewIds.size,
      hours: Math.round(hours * 10) / 10,
    }
  }, [todayVisits, employees])

  // Per-crew workload for today — powers the desktop dispatch board's
  // right-side utilization panel. Keyed by cleaner_id; each entry has
  // total hours, the visits, and a capacity percentage against the same
  // 8h/day floor used above.
  const crewLoad = useMemo(() => {
    const map = new Map()
    todayVisits.forEach(v => {
      const dur = hoursBetween(v.start_time, v.end_time)
      ;(v.cleaner_ids || []).forEach(id => {
        const prev = map.get(id) || { hours: 0, visits: [] }
        prev.hours += dur
        prev.visits.push(v)
        map.set(id, prev)
      })
    })
    // Include cleaners who are on the roster but idle today so the panel
    // can offer them as "4.5h open — suggest reassignment" targets.
    ;(employees || []).forEach(e => {
      if (!map.has(e.id)) map.set(e.id, { hours: 0, visits: [] })
    })
    const out = []
    map.forEach((row, id) => {
      const capacityPct = Math.min(100, Math.round((row.hours / HOURS_PER_CREW_DAY) * 100))
      out.push({
        id,
        hours: Math.round(row.hours * 10) / 10,
        capacityPct,
        visits: row.visits.sort((a, b) =>
          (a.start_time || '99:99').localeCompare(b.start_time || '99:99'),
        ),
      })
    })
    // Highest-loaded first — that's the crew you're most likely to move a
    // job away from.
    return out.sort((a, b) => b.hours - a.hours)
  }, [todayVisits, employees])

  // Unassigned queue for today — sorted by start time so the dispatch
  // board reads top-down chronologically.
  const unassignedToday = useMemo(
    () => todayVisits
      .filter(isUnassigned)
      .sort((a, b) => (a.start_time || '99:99').localeCompare(b.start_time || '99:99')),
    [todayVisits],
  )

  const isTodaySelected = dateStr === todayYMD()

  return {
    weekDates,
    loadByDate,
    todayVisits,
    todayStats,
    crewLoad,
    unassignedToday,
    isTodaySelected,
    HOURS_PER_CREW_DAY,
  }
}
