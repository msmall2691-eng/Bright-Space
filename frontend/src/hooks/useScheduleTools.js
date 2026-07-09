import { useState } from 'react'
import { get, post } from '../api'

/** Tools-menu business logic for the Schedule page:
 *  - Google Calendar sync now (one combined pull+push call — auto-sync in
 *    Settings -> Automation is what's meant to keep this current day-to-day)
 *  - Auto-assign turnovers (preview → apply)
 *  - Fix missing job times (diagnose → preview → apply)
 *
 *  Each action follows preview-then-confirm: preview* opens a modal
 *  (state = {loading} → {preview,…}), run* applies (state → {…, running})
 *  and calls `refresh` on success. Toasts communicate outcomes.
 *
 *  Parent passes `toast` (from useToast) and `refresh` (from useScheduleData)
 *  so this hook stays free of shared context — just business logic. */
export function useScheduleTools({ toast, refresh }) {
  const [autoAssign, setAutoAssign] = useState(null)
  const [fixTimes, setFixTimes] = useState(null)

  // Single "Sync now" action for the Tools menu — auto-sync (Settings ->
  // Automation) is meant to keep Google Calendar current in the background,
  // so a small team shouldn't need to think about "pull vs push" as two
  // separate manual steps; this is the one-button fallback for "do it now".
  const [syncingNow, setSyncingNow] = useState(false)
  const syncNow = async () => {
    if (syncingNow) return
    setSyncingNow(true)
    try {
      const pullRes = await post('/api/jobs/sync-gcal', {}).catch(() => null)
      const pushRes = await post('/api/jobs/push-to-gcal', {}).catch(() => null)
      const parts = []
      const c = pullRes?.jobs_created || 0, u = pullRes?.jobs_updated || 0
      if (c) parts.push(`${c} new`)
      if (u) parts.push(`${u} updated`)
      if (pushRes?.pushed) parts.push(`${pushRes.pushed} pushed`)
      toast.success(parts.length ? `Synced with Google — ${parts.join(', ')}` : 'Synced with Google — up to date')
      refresh()
    } catch (e) {
      toast.error(e.message || 'Sync failed')
    }
    setSyncingNow(false)
  }

  // One-click repair for the "Needs attention" strip: pushes unsynced jobs to
  // Google AND dispatches missing Connecteam shifts in a single call.
  const [fixingSync, setFixingSync] = useState(false)
  const fixSync = async () => {
    if (fixingSync) return
    setFixingSync(true)
    try {
      const r = await post('/api/jobs/sync-reconcile', {})
      toast.success(r?.message || 'Sync reconcile complete')
      refresh()
    } catch (e) {
      toast.error(e?.message || 'Sync fix failed')
    }
    setFixingSync(false)
  }

  const previewAutoAssign = async () => {
    setAutoAssign({ loading: true })
    try {
      const res = await post('/api/jobs/auto-assign-turnovers?dry_run=true', {})
      if (!res?.assigned?.length && !res?.unassignable?.length) {
        setAutoAssign(null)
        toast.info('No unassigned turnovers to fill')
        return
      }
      setAutoAssign({ preview: res })
    } catch (e) {
      setAutoAssign(null)
      toast.error(e.message || 'Could not preview auto-assign')
    }
  }

  const runAutoAssign = async () => {
    setAutoAssign(a => ({ ...a, running: true }))
    try {
      const res = await post('/api/jobs/auto-assign-turnovers', {})
      toast.success(`Assigned ${res?.assigned?.length || 0} turnover${(res?.assigned?.length || 0) === 1 ? '' : 's'}`)
      setAutoAssign(null)
      refresh()
    } catch (e) {
      toast.error(e.message || 'Auto-assign failed')
      setAutoAssign(a => ({ ...a, running: false }))
    }
  }

  const previewFixTimes = async () => {
    setFixTimes({ loading: true })
    try {
      const [diag, preview] = await Promise.all([
        get('/api/jobs/diagnostics/missing-times').catch(() => null),
        post('/api/jobs/backfill-missing-times?dry_run=true', {}),
      ])
      if (!preview?.count) {
        setFixTimes(null)
        toast.info('All jobs already have times — no fix needed')
        return
      }
      setFixTimes({ preview, bySource: diag?.summary?.by_source || {} })
    } catch (e) {
      setFixTimes(null)
      toast.error(e.message || 'Could not check job times')
    }
  }

  const runFixTimes = async () => {
    setFixTimes(f => ({ ...f, running: true }))
    try {
      const res = await post('/api/jobs/backfill-missing-times', {})
      toast.success(`Set times on ${res?.count || 0} job${(res?.count || 0) === 1 ? '' : 's'}`)
      setFixTimes(null)
      refresh()
    } catch (e) {
      toast.error(e.message || 'Fix failed')
      setFixTimes(f => ({ ...f, running: false }))
    }
  }

  return {
    syncingNow, syncNow,
    fixingSync, fixSync,
    autoAssign, setAutoAssign, previewAutoAssign, runAutoAssign,
    fixTimes, setFixTimes, previewFixTimes, runFixTimes,
  }
}
