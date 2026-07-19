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
 *  Parent passes `toast` (from utils/toastBus) and `refresh` (from useScheduleData)
 *  so this hook stays free of shared context — just business logic. */
export function useScheduleTools({ toast, refresh }) {
  const [autoAssign, setAutoAssign] = useState(null)
  const [fixTimes, setFixTimes] = useState(null)

  // Single "Push now" action for the Tools menu. One-way (BrightBase is
  // master): this pushes the schedule OUT to Google + Connecteam right now —
  // the same push-only reconcile as "Fix sync". It deliberately does NOT hit
  // /api/jobs/sync-gcal, which reads Google BACK (importing Google-only events
  // and cancelling jobs deleted in Google) and would contradict one-way.
  const [syncingNow, setSyncingNow] = useState(false)
  const syncNow = async () => {
    if (syncingNow) return
    setSyncingNow(true)
    try {
      const r = await post('/api/jobs/sync-reconcile', {})
      const parts = []
      if (r?.gcal?.pushed) parts.push(`${r.gcal.pushed} to Google`)
      if (r?.connecteam?.dispatched) parts.push(`${r.connecteam.dispatched} to Connecteam`)
      toast.success(parts.length ? `Pushed — ${parts.join(', ')}` : 'Everything’s already pushed')
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
