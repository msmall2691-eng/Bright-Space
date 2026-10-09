import { useEffect, useState, useMemo } from 'react'
import { getCached } from '../api'

/**
 * Shared employees roster.
 *
 * Before this hook the roster was fetched independently in useScheduleData,
 * CalendarView, JobEditModal, JobCreateModal, ConvertToJobModal, ScheduleTabs
 * (AvailabilityPanel), and the old Dashboard's useDashboardData — seven
 * parallel requests to `/api/dispatch/employees` when the operator opens
 * Schedule. Audit §18 called that out. This hook routes its callers through
 * the existing getCached() dedup + result cache in api.js, with a two-minute
 * TTL that matches how rarely the roster changes.
 *
 * Two of those seven were never actually converted, and this comment claimed
 * otherwise until the orphaned-dashboard cleanup went looking:
 *   - useDashboardData was dead code and is gone (nothing imported it after
 *     the Dashboard page itself was removed), so its raw fetch is moot.
 *   - ScheduleTabs' AvailabilityPanel still calls `get()` directly. On
 *     `?tab=availability` that is a genuine second roster request on one
 *     screen, because Schedule's useScheduleData calls this hook
 *     unconditionally. Its own slice.
 *
 * Returns:
 *   employees          — raw array from the API (empty until loaded)
 *   employeeById       — { [id]: employee } map for O(1) lookup
 *   empName(id)        — the display-name helper every caller re-derived
 *   loading, error     — small state a caller can use for skeleton/toast
 */

const CACHE_URL = '/api/dispatch/employees'
const CACHE_TTL_MS = 2 * 60 * 1000  // 2 minutes — roster changes rarely

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
