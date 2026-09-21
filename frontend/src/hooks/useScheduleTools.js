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
  const [ghosts, setGhosts] = useState(null)

  // NOTE: the old "Push now" / "Fix sync" actions were removed — the
  // SyncHealthPill in the toolbar now owns the (rarely-needed) manual
  // /api/jobs/sync-reconcile override, and the background reconcile does it
  // automatically. This hook is just the preview-then-apply maintenance tools.

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

  // Remove cancelled turnover "ghosts" — the piles of cancelled duplicate
  // turnovers a flapping iCal feed leaves stacked on one date. Preview (with a
  // per-property breakdown) then confirm; the server only ever deletes
  // cancelled str_turnover rows and never one that carries an invoice.
  const previewGhosts = async () => {
    setGhosts({ loading: true })
    try {
      const res = await post('/api/jobs/purge-cancelled-turnovers?dry_run=true', {})
      if (!res?.count) {
        setGhosts(null)
        toast.info('No cancelled turnover clutter to clear')
        return
      }
      setGhosts({ preview: res })
    } catch (e) {
      setGhosts(null)
      toast.error(e.message || 'Could not check for cancelled turnovers')
    }
  }

  const runGhosts = async () => {
    // There can be THOUSANDS of ghosts (a flapping feed once left 6,400+ on one
    // property), and the API client aborts at 15s — so we can't delete them all
    // in one request. Delete in bounded chunks and loop until the server reports
    // remaining === 0, showing a live count. Each committed chunk stays gone, so
    // this is safe to stop and resume.
    const total = ghosts?.preview?.count || 0
    setGhosts(g => (g ? { ...g, running: true, removed: 0, total } : g))
    let removed = 0
    try {
      for (;;) {
        const res = await post('/api/jobs/purge-cancelled-turnovers?max_delete=400', {}, { timeout: 60000 })
        removed += res?.deleted || 0
        setGhosts(g => (g ? { ...g, removed } : g))
        // Stop when nothing is left, or when a chunk deletes nothing (only
        // undeletable/skipped rows remain) — never loop forever.
        if (!res || res.remaining === 0 || !res.deleted) break
      }
      toast.success(`Removed ${removed} cancelled turnover${removed === 1 ? '' : 's'}`)
      setGhosts(null)
      refresh()
    } catch (e) {
      // Partial progress is already committed server-side; tell them where it
      // stopped so a re-run finishes the rest.
      toast.error(`${removed ? `Removed ${removed}, then ` : ''}${e.message || 'cleanup failed'} — re-run to finish`)
      setGhosts(g => (g ? { ...g, running: false } : g))
      refresh()
    }
  }

  return {
    autoAssign, setAutoAssign, previewAutoAssign, runAutoAssign,
    fixTimes, setFixTimes, previewFixTimes, runFixTimes,
    ghosts, setGhosts, previewGhosts, runGhosts,
  }
}
