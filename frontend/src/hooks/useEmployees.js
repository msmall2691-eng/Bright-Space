import { useEffect, useState, useMemo } from 'react'
import { getCached } from '../api'

/**
 * Shared employees roster.
 *
 * Before this hook the roster was fetched independently in seven places —
 * seven parallel requests to `/api/dispatch/employees` when the operator
 * opened Schedule, which audit §18 called out. This hook routes its callers
 * through the existing getCached() dedup + result cache in api.js, with a
 * two-minute TTL that matches how rarely the roster changes.
 *
 * It listed all seven by name and was wrong about three of them, which the
 * orphaned-dashboard cleanup found while tracing the import graph. Checked
 * one at a time, the seven are:
 *   - useScheduleData, CalendarView, JobEditModal, JobCreateModal — converted,
 *     still here, still on this hook.
 *   - ScheduleTabs' AvailabilityPanel — claimed for a long time, actually
 *     converted only in #1147, once a test counting `fetch` calls showed the
 *     roster going out TWICE on `?tab=availability`: Schedule's
 *     useScheduleData calls this hook unconditionally (hooks can't be
 *     conditional; its `enabled` option gates only the week fetch), and the
 *     panel's raw `get()` could not share the in-flight promise.
 *   - useDashboardData — was dead code and is now deleted. Nothing had
 *     imported it since the Dashboard page itself was removed, so its raw
 *     fetch had not cost a request in a long time.
 *   - ConvertToJobModal — no such file exists anywhere in the tree.
 *
 * So the live count is five callers sharing one cached fetch, not seven.
 * Worth the words: a comment claiming a de-duplication that had not happened
 * is how the one real duplicate survived an economy audit for months. The
 * count is pinned by a test now
 * (components/schedule/__tests__/availabilityRoster.test.jsx) rather than by
 * this paragraph.
 *
 * Returns:
 *   employees          — raw array from the API (empty until loaded)
 *   employeeById       — { [id]: employee } map for O(1) lookup
 *   empName(id)        — the display-name helper every caller re-derived
 *   loading, error     — small state a caller can use for skeleton/toast
 */

/** The one definition of the roster URL. Exported so the Crew page can drop
 *  this cache after a write without re-typing the string — a second copy is
 *  how a URL and the thing that caches it drift apart. */
export const ROSTER_CACHE_URL = '/api/dispatch/employees'
const CACHE_URL = ROSTER_CACHE_URL
// 2 minutes — the roster changes rarely, and when it DOES change the Crew page
// calls invalidateCached(ROSTER_CACHE_URL) rather than leaving every assign
// drop-down two minutes behind.
const CACHE_TTL_MS = 2 * 60 * 1000

export function useEmployees() {
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getCached(CACHE_URL, CACHE_TTL_MS)
      .then((data) => {
        if (cancelled) return
        setEmployees(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err)
        setEmployees([])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const employeeById = useMemo(() => {
    // Index both by id and by userId — legacy rosters keyed cleaners by
    // userId in some places, by id in others, and the old useScheduleData
    // helper supported both keys.
    const m = {}
    for (const e of employees) {
      if (!e) continue
      if (e.id != null) m[String(e.id)] = e
      if (e.userId != null) m[String(e.userId)] = e
    }
    return m
  }, [employees])

  const empName = useMemo(() => (id) => {
    if (id == null) return ''
    const e = employeeById[String(id)]
    return e?.name || `Cleaner ${id}`
  }, [employeeById])

  return { employees, employeeById, empName, loading, error }
}
