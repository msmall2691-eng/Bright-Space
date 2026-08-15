import { useEffect, useState } from 'react'
import { get, patch } from '../api'

/** Per-category push-notification preferences (GET/PATCH /api/push/preferences).
 *  One fetch per screen — office (NotificationsCard) and crew (CrewSetupCard/
 *  Me tab) each mount this once. `prefs` is `null` while loading, then a
 *  {category: bool} map with every category for the caller's role filled in
 *  (missing/true = on). `toggle(category)` optimistically flips it and PATCHes;
 *  reverts on failure so the UI never shows a state the server rejected. */
export function useNotificationPrefs() {
  const [prefs, setPrefs] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    get('/api/push/preferences')
      .then(d => { if (!cancelled) setPrefs(d) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [])

  const toggle = async (category) => {
    setPrefs(prev => (prev ? { ...prev, [category]: !prev[category] } : prev))
    try {
      const next = { [category]: !(prefs?.[category] ?? true) }
      await patch('/api/push/preferences', next)
    } catch {
      // Revert on failure — server rejected it (role mismatch) or the
      // request never landed.
      setPrefs(prev => (prev ? { ...prev, [category]: !prev[category] } : prev))
    }
  }

  return { prefs, error, toggle }
}
