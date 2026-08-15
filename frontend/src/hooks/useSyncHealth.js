import { useState, useEffect, useCallback } from 'react'
import { get } from '../api'

/**
 * Shared schedule sync-health poller. The Schedule toolbar renders a
 * SyncHealthPill in BOTH the phone and desktop layouts (one is only CSS-hidden,
 * not unmounted), so a naive per-component fetch would run two initial requests
 * and two 60s polling loops — and each request scans upcoming jobs and runs the
 * full schedule audit. This module-level singleton dedupes them: every mounted
 * pill subscribes to one cache and one interval, and concurrent loads collapse
 * into a single in-flight request.
 */
let _cache = null
let _timer = null
let _inflight = null
const _subs = new Set()

function _emit() { _subs.forEach((fn) => fn(_cache)) }

function _load() {
  if (_inflight) return _inflight
  _inflight = get('/api/jobs/sync-health')
    .then((r) => { _cache = r; _emit() })
    .catch(() => { /* keep the last good value; a blip shouldn't blank the pill */ })
    .finally(() => { _inflight = null })
  return _inflight
}

/** Test-only: clear the singleton between cases. */
export function __resetSyncHealth() {
  _cache = null
  if (_timer) { clearInterval(_timer); _timer = null }
  _inflight = null
  _subs.clear()
}

export function useSyncHealth(refreshKey = 0) {
  const [health, setHealth] = useState(_cache)

  useEffect(() => {
    _subs.add(setHealth)
    // Hidden-tab guard (economy audit M3): sync-health runs a schedule audit
    // server-side per call — don't pay for it while nobody's looking.
    if (!_timer) _timer = setInterval(() => { if (!document.hidden) _load() }, 60_000)
    // Always fetch fresh on mount (deduped) so a newly-shown pill isn't stale.
    _load()
    return () => {
      _subs.delete(setHealth)
      if (_subs.size === 0 && _timer) { clearInterval(_timer); _timer = null }
    }
  }, [])

  // Force a refresh when the parent bumps refreshKey (e.g. after an edit).
  useEffect(() => { if (refreshKey) _load() }, [refreshKey])

  const refresh = useCallback(() => _load(), [])
  return { health, refresh }
}
