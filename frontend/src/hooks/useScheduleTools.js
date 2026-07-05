import { useState } from 'react'
import { get, post } from '../api'

/** Tools-menu business logic for the Schedule page:
 *  - Google Calendar sync (pull) + push
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
  const [gcalSyncing, setGcalSyncing] = useState(false)
  const [gcalPushing, setGcalPushing] = useState(false)
  const [autoAssign, setAutoAssign] = useState(null)
  const [fixTimes, setFixTimes] = useState(null)

  const syncFromGoogle = async () => {
    if (gcalSyncing) return
    setGcalSyncing(true)
    try {
      const r = await post('/api/jobs/sync-gcal', {})
      const c = r?.jobs_created || 0, u = r?.jobs_updated || 0, x = r?.jobs_cancelled || 0
      const parts = []
      if (c) parts.push(`${c} new`)
      if (u) parts.push(`${u} updated`)
      if (x) parts.push(`${x} cancelled`)
      toast.success(parts.length ? `Synced from Google — ${parts.join(', ')}` : 'Synced from Google — up to date')
      refresh()
    } catch (e) {
      toast.error(e.message || 'Google sync failed')
    }
    setGcalSyncing(false)
  }

  const pushToGoogle = async () => {
    if (gcalPushing) return
    setGcalPushing(true)
    try {
      const r = await post('/api/jobs/push-to-gcal', {})
      toast.success(r?.message || `Pushed ${r?.pushed || 0} job(s) to Google`)
      refresh()
    } catch (e) {
      const msg = e?.message || 'Push failed'
      toast.error(/not configured/i.test(msg)
        ? 'Google Calendar isn’t connected on the server (credentials missing)'
        : msg)
    }
    setGcalPushing(false)
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
    gcalSyncing, syncFromGoogle,
    gcalPushing, pushToGoogle,
    fixingSync, fixSync,
    autoAssign, setAutoAssign, previewAutoAssign, runAutoAssign,
    fixTimes, setFixTimes, previewFixTimes, runFixTimes,
  }
}
