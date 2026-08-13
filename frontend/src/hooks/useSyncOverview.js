import { useState, useEffect, useCallback, useRef } from 'react'
import { get } from '../api'

/**
 * Poller for the Sync Control Center (`/sync`). One read — GET
 * /api/jobs/sync-overview — returns every schedule BrightBase syncs with
 * (Google / Airbnb-iCal / recurring), the background ticks, and
 * the attention list. Refreshes every 60s and exposes refresh() so an action
 * (pause a channel, "sync now") can re-pull immediately.
 *
 * Deliberately NOT the module-level singleton useSyncHealth uses — that pill
 * mounts twice (phone + desktop toolbar) and must dedupe; this hook backs a
 * single full-page view, so a plain per-mount fetch is correct and simpler.
 */
export function useSyncOverview() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const timer = useRef(null)

  const load = useCallback(async () => {
    try {
      const r = await get('/api/jobs/sync-overview')
      setData(r)
      setError(null)
    } catch (e) {
      // Keep the last good snapshot on a blip; only surface a hard error when
      // we have nothing to show yet.
      setError(e?.message || 'Could not load sync status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, 60_000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  return { data, loading, error, refresh: load }
}
