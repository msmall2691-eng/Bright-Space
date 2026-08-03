import { useEffect, useState } from 'react'
import { get } from '../api'

// Module-level cache + in-flight promise so the inbox doesn't refetch company
// settings on every conversation open — the value is effectively static per
// session. Falls back to the business name if settings can't be read.
const FALLBACK = 'The Maine Cleaning Co.'
let _cached = null
let _inflight = null

function fetchName() {
  if (_cached) return Promise.resolve(_cached)
  if (_inflight) return _inflight
  _inflight = get('/api/settings/general')
    .then(d => d?.company_name)
    .catch(() => null)
    // /general is the canonical source; older deployments only expose /settings.
    .then(name => name || get('/api/settings').then(d => d?.company_name).catch(() => null))
    .then(name => { _cached = name || FALLBACK; return _cached })
    .finally(() => { _inflight = null })
  return _inflight
}

/** Company display name for outbound SMS templates (reminders, confirmations). */
export function useCompanyName() {
  const [name, setName] = useState(_cached || FALLBACK)
  useEffect(() => {
    let cancelled = false
    fetchName().then(n => { if (!cancelled) setName(n) })
    return () => { cancelled = true }
  }, [])
  return name
}
