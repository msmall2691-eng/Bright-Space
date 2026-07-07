import { useEffect, useState, useMemo } from 'react'
import { get } from '../api'
import { toLocalYMD } from '../utils/format'
import { rangeForView } from '../utils/dateRange'
import { useEmployees } from './useEmployees'

/** Loads the /api/schedule/week aggregate (visits + jobs + properties +
 *  clients) for the range implied by `viewMode` around `currentDate`,
 *  plus the Connecteam employee roster used for cleaner-name lookup.
 *
 *  Audit §16: the range is now view-aware. agenda + week fetch the
 *  Sun-Sat week (unchanged). Month fetches the full calendar-grid range
 *  (first Sunday on-or-before the 1st, last Saturday on-or-after the
 *  last) so a single fetch feeds both the health strip and the month
 *  grid — no more two-fetch mismatch where the strip counted the week's
 *  jobs while the grid showed the month's.
 *
 *  Returns the four indexed maps + list + `range` (the [start, end]
 *  actually fetched, so CalendarView can skip its own fetch when the
 *  parent already covers its month) + a `refresh()` bump, plus
 *  `setVisits` / `setJobs` so the parent can patch local state after a
 *  successful mutation without waiting for a full refetch. `empName(id)`
 *  resolves a cleaner id to a display name. */
export function useScheduleData(currentDate, viewMode = 'week') {
  const [visits, setVisits] = useState([])
  const [jobs, setJobs] = useState({})
  const [properties, setProperties] = useState({})
  const [clients, setClients] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // Employees roster comes from the shared useEmployees hook so this
  // caller shares the getCached() 2-minute TTL with CalendarView,
  // JobEditModal, and the other roster consumers (audit §18).
  const { employees, empName } = useEmployees()

  // Serialize the range so the useEffect deps stay primitive (avoids
  // re-firing on every render when the object identity changes).
  const range = useMemo(() => rangeForView(currentDate, viewMode), [currentDate, viewMode])
  const rangeKey = `${range.start}|${range.end}`

  useEffect(() => {
    const loadSchedule = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const start = range.start
        const end = range.end

        // One aggregate call returns the whole week (visits + jobs + properties
        // + clients) instead of four parallel round trips. Shapes are identical
        // to the standalone endpoints the server delegates to.
        let week
        try {
          week = await get(
            `/api/schedule/week?scheduled_date_from=${start}&scheduled_date_to=${end}`
          )
        } catch (e) {
          // Total failure (timeout / server down): surface a retryable error
          // rather than rendering an empty week.
          console.error('[Schedule] Week API error:', e)
          setLoadError(true)
          setLoading(false)
          return
        }
        const jobsMap = {}
        const propsMap = {}
        const clientsMap = {}
        const jobsList = Array.isArray(week?.jobs) ? week.jobs : []
        const propsList = Array.isArray(week?.properties) ? week.properties : []
        const clientsList = Array.isArray(week?.clients) ? week.clients : []
        jobsList.forEach(j => jobsMap[j.id] = j)
        propsList.forEach(p => propsMap[p.id] = p)
        clientsList.forEach(c => clientsMap[c.id] = c)

        // /api/schedule/week's `visits` array is derived from jobs by the
        // backend since the Job/Visit unification (see modules/schedule/router.py).
        const displayData = Array.isArray(week?.visits) ? week.visits : []
        setVisits(displayData)
        setJobs(jobsMap)
        setProperties(propsMap)
        setClients(clientsMap)
      } catch (err) {
        console.error('[Schedule]', err)
      }
      setLoading(false)
    }
    loadSchedule()
    // rangeKey is the primitive string form of `range` so React can compare
    // it cheaply; refreshKey lets refresh() re-fire without a range change.
  }, [rangeKey, refreshKey])

  const refresh = () => setRefreshKey(k => k + 1)

  return {
    visits, setVisits,
    jobs, setJobs,
    properties,
    clients,
    loading, loadError,
    refresh,
    employees, empName,
    // The range that's actually loaded. CalendarView reads this to decide
    // whether the parent's data covers its month grid — if yes, skip the
    // duplicate /api/jobs fetch (audit §16).
    range,
  }
}
