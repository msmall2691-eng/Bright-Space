import { useState } from 'react'
import { CheckCircle2, RefreshCw, AlertTriangle, ChevronDown, Cloud } from 'lucide-react'
import { post } from '../../api'
import { useSyncHealth } from '../../hooks/useSyncHealth'
import { canEdit } from '../../utils/perms'

/**
 * Passive schedule health indicator — the antidote to the "pile of manual push
 * buttons" problem. It reads GET /api/jobs/sync-health and shows one calm pill:
 *
 *   • ok        → green  "Auto-sync on"      (nothing to do; it just flows)
 *   • syncing   → blue   "Syncing N…"        (a backlog the ticks will clear)
 *   • attention → amber  "N need attention"  (duplicates/orphans/disconnect)
 *
 * Clicking opens a small panel (the "accuracy panel") that breaks down what the
 * background automation is doing — Google connection, auto-flow toggles,
 * unsynced counts, and any integrity issues — plus a single "Sync now"
 * OVERRIDE. The override exists only for impatience/debugging; the copy makes
 * clear the schedule syncs on its own, so the operator stops feeling they must
 * click anything.
 *
 * Props:
 *   refreshKey  — bump to force a re-fetch (e.g. after an edit).
 *   onForced    — called after a manual sync so the parent can refresh its data.
 *   onOpenSettings — optional; opens the Sync & automation drawer.
 */
export default function SyncHealthPill({ refreshKey = 0, onForced, onOpenSettings }) {
  // One shared poller across every mounted pill (phone + desktop layouts) so the
  // page doesn't run two health requests / two intervals.
  const { health, refresh } = useSyncHealth(refreshKey)
  const [open, setOpen] = useState(false)
  const [forcing, setForcing] = useState(false)
  // The manual override calls POST /sync-reconcile, which the backend restricts
  // to admin/manager. Hide it from viewers so they don't hit a silent 403.
  const mayForce = canEdit()

  // The pill is the ONLY manual sync path now, so a failed "Sync now" must be
  // visible (not a silent spinner-stop the operator mistakes for success).
  const [forceError, setForceError] = useState(null)
  const forceSync = async () => {
    if (forcing) return
    setForcing(true)
    setForceError(null)
    try {
      await post('/api/jobs/sync-reconcile', {})
      await refresh()
      onForced?.()
    } catch (e) {
      setForceError(e?.message || 'Sync failed — please try again.')
    }
    setForcing(false)
  }

  if (!health) return null

  const overall = health.overall || 'ok'
  const backlog = health.google?.unsynced_count || 0
  const issues = (health.issues?.duplicate_jobs || 0) + (health.issues?.orphaned_shifts || 0)

  // Quiet secondary-button trigger — the status hue lives in a small dot,
  // not a tinted capsule (owner vetoed the bubble labels). Icons keep a
  // muted tone so "syncing" still visibly spins.
  const style = {
    ok:        { dot: 'bg-emerald-500', Icon: CheckCircle2, label: 'Auto-sync on' },
    syncing:   { dot: 'bg-blue-500', Icon: RefreshCw, label: `Syncing ${backlog}…` },
    attention: { dot: 'bg-amber-500', Icon: AlertTriangle, label: issues ? `${issues} need attention` : 'Needs attention' },
  }[overall]
  const { dot, Icon, label } = style

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-md bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 text-xs font-medium transition-colors"
        title="Schedule sync health — click for details"
        data-testid="sync-health-pill"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
        {overall === 'syncing' && <Icon className="w-3.5 h-3.5 animate-spin text-ink-3" />}
        <span className="hidden sm:inline">{label}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-72 bg-panel border border-hairline rounded-xl shadow-lg z-50 p-3 text-sm">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
              <span className="font-bold text-ink">
                {overall === 'ok' ? 'Everything’s in sync'
                  : overall === 'syncing' ? 'Catching up automatically'
                  : 'A few things need a look'}
              </span>
            </div>

            <p className="text-[12px] text-ink-3 mb-3 leading-snug">
              {health.auto_flow_on
                ? 'The schedule syncs itself — feeds pull in, jobs post to Google, and everything stays reconciled. No manual push needed.'
                : 'Auto-sync is partly off, so some changes won’t flow on their own until it’s re-enabled in settings.'}
            </p>

            <Row Icon={Cloud} label="Google Calendar"
                 ok={health.google?.configured}
                 note={health.google?.configured
                   ? (health.google?.unsynced_count ? `${health.google.unsynced_count} pending` : 'all posted')
                   : 'not connected'} />

            {issues > 0 && (
              <div className="mt-2 px-2 py-1.5 rounded-lg border border-hairline bg-bg text-[12px] text-ink-2">
                {health.issues.duplicate_jobs > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                    {health.issues.duplicate_jobs} duplicate job group(s)
                  </div>
                )}
                {health.issues.orphaned_shifts > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                    {health.issues.orphaned_shifts} orphaned shift(s)
                  </div>
                )}
                <div className="text-ink-3 mt-0.5">Review in the schedule audit.</div>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              {mayForce && (
                <button
                  onClick={forceSync}
                  disabled={forcing}
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg bg-bg-2 text-ink-2 text-xs font-semibold hover:bg-bg disabled:opacity-50 transition-colors"
                  title="Runs the same reconcile the background already does — for when you don’t want to wait."
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${forcing ? 'animate-spin' : ''}`} />
                  {forcing ? 'Syncing…' : 'Sync now'}
                </button>
              )}
              {onOpenSettings && (
                <button
                  onClick={() => { setOpen(false); onOpenSettings() }}
                  className={`h-8 px-2.5 rounded-lg bg-bg-2 text-ink-3 text-xs font-semibold hover:bg-bg transition-colors ${mayForce ? '' : 'flex-1'}`}
                >
                  Settings
                </button>
              )}
            </div>
            {forceError && (
              <p className="mt-2 px-2 py-1.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-[12px] text-red-700 dark:text-red-300" role="alert">
                {forceError}
              </p>
            )}
            {mayForce && (
              <p className="text-[10px] text-ink-3/70 mt-1.5 text-center">Sync runs automatically — this is just a shortcut.</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ Icon, label, ok, note }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <Icon className="w-3.5 h-3.5 text-ink-3 shrink-0" />
      <span className="text-[12px] text-ink-2 flex-1">{label}</span>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-ink-3/40'}`} />
      <span className="text-[11px] text-ink-3">{note}</span>
    </div>
  )
}
