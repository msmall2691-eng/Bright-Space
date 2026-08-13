import { useEffect, useState, useMemo, useRef } from 'react'
import { get } from '../api'
import { toLocalYMD } from '../utils/format'
import { rangeForView } from '../utils/dateRange'
import { useEmployees } from './useEmployees'

/** Loads the /api/schedule/week aggregate (visits + jobs + properties +
 *  clients) for the range implied by `viewMode` around `currentDate`,
 *  plus the crew roster used for cleaner-name lookup.
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
 *  resolves a cleaner id to a display name.
 *
 *  Tier 5 roadmap #16 "realtime refresh": also polls every `pollMs` (default
 *  45s) so a second admin's edits show up without a manual Refresh click.
 *  Paused while the tab is hidden (Page Visibility API) so background tabs
 *  don't burn requests. This is deliberately last-write-wins, same as a
 *  manual refresh — no optimistic locking — it just shortens the staleness
 *  window between two people editing the same schedule.
 *
 *  `enabled` (default true) skips the fetch AND the poll entirely — for
 *  callers like Schedule.jsx that mount this hook unconditionally (Rules of
 *  Hooks) but sometimes render a sub-page that never reads visits/jobs, so
 *  the /api/schedule/week fetch + its 45s poll would otherwise run
 *  continuously in the background for no reason (July-2026 audit #5
 *  follow-up). Re-enabling refetches immediately at the current range. */
export function useScheduleData(currentDate, viewMode = 'week', { pollMs = 45000, enabled = true } = {}) {
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

  // Set by the poll timer right before it bumps refreshKey, consumed by the
  // very next loadSchedule() run below. Lets a background poll's failure
  // degrade to a silent no-op (keep showing whatever's already on screen)
  // instead of the full-page ErrorState or initial skeleton a user-initiated
  // load/retry is supposed to show on failure.
  const isBackgroundPollRef = useRef(false)

  // Signature of the last-applied payload. A background poll every 45s used to
  // call setVisits/setJobs/setProperties/setClients unconditionally — even when
  // the server returned byte-identical data — handing every consumer brand-new
  // array/object identities and re-laying-out the whole schedule (and every
  // memo downstream) for nothing. We now diff the fetched payload against this
  // and skip the state churn when nothing changed. Only gates BACKGROUND polls,
  // so a range change / manual refresh / re-enable still applies immediately,
  // and it never fights an optimistic local edit: an unchanged server payload
  // means "leave local state alone," which preserves the optimistic move.
  const lastSigRef = useRef(null)

  useEffect(() => {
    if (!enabled) return
    const backgroundPoll = isBackgroundPollRef.current
    isBackgroundPollRef.current = false
    // Fast week-to-week navigation can have two loadSchedule() calls in
    // flight at once; whichever resolves LAST used to win regardless of
    // which range it was actually fetching, so a slow response for the
    // week you just left could overwrite the week you navigated to. This
    // flag (same pattern as the integration-events effect above) makes a
    // superseded run's result a no-op instead.
    let cancelled = false
    const loadSchedule = async () => {
      if (!backgroundPoll) {
        setLoading(true)
        setLoadError(false)
      }
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
          if (cancelled) return
          // Total failure (timeout / server down): surface a retryable error
          // rather than rendering an empty week — but only for a real
          // (non-background-poll) load. A poll failing is just a transient
          // blip; the tab already has a valid schedule on screen and should
          // keep it rather than getting blown away every 45s by a 5xx.
          console.error('[Schedule] Week API error:', e)
          if (!backgroundPoll) {
            setLoadError(true)
            setLoading(false)
          }
          return
        }
        if (cancelled) return

        // Cheap change-detection: a background poll that returns the same data
        // as last time is a no-op — bail before touching state so we don't
        // trigger the full re-render/re-layout cascade every 45s. JSON.stringify
        // of the four lists runs once per poll (45s cadence), which is trivial
        // next to the render work it saves.
        const sig = JSON.stringify([week?.visits, week?.jobs, week?.properties, week?.clients])
        if (backgroundPoll && sig === lastSigRef.current) return
        lastSigRef.current = sig

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
      if (!cancelled && !backgroundPoll) setLoading(false)
    }
    loadSchedule()
    // rangeKey is the primitive string form of `range` so React can compare
    // it cheaply; refreshKey lets refresh() re-fire without a range change.
    // `enabled` is included so flipping it back on triggers an immediate
    // refetch instead of waiting for the next range change or poll tick.
    return () => { cancelled = true }
  }, [rangeKey, refreshKey, enabled])

  const refresh = () => setRefreshKey(k => k + 1)

  useEffect(() => {
    if (!enabled || !pollMs) return
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      isBackgroundPollRef.current = true
      refresh()
    }, pollMs)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs, enabled])

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
