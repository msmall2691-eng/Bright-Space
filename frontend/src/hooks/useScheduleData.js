import { useEffect, useState } from 'react'
import { get } from '../api'

/** Loads the /api/schedule/week aggregate (visits + jobs + properties +
 *  clients) for the week containing `currentDate`, plus the Connecteam
 *  employee roster used for cleaner-name lookup.
 *
 *  Returns the four indexed maps + list + a `refresh()` bump, plus
 *  `setVisits` / `setJobs` so the parent can patch local state after a
 *  successful mutation (delete, complete, toggle-reminder) without waiting
 *  for a full refetch. `empName(id)` resolves a cleaner id to a display name. */
export function useScheduleData(currentDate) {
  const [visits, setVisits] = useState([])
  const [jobs, setJobs] = useState({})
  const [properties, setProperties] = useState({})
  const [clients, setClients] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [employees, setEmployees] = useState([])

  useEffect(() => {
    get('/api/dispatch/employees')
      .then(r => setEmployees(Array.isArray(r) ? r : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const loadSchedule = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const startDate = new Date(currentDate)
        startDate.setDate(startDate.getDate() - startDate.getDay())
        const endDate = new Date(startDate)
        endDate.setDate(endDate.getDate() + 6)

        const start = startDate.toISOString().split('T')[0]
        const end = endDate.toISOString().split('T')[0]

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
  }, [currentDate, refreshKey])

  const refresh = () => setRefreshKey(k => k + 1)
  const empName = (id) =>
    employees.find(e => String(e.id) === String(id) || String(e.userId) === String(id))?.name
    || `Cleaner ${id}`

  return {
    visits, setVisits,
    jobs, setJobs,
    properties,
    clients,
    loading, loadError,
    refresh,
    employees, empName,
  }
}
