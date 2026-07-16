import { useState } from 'react'
import { AlertTriangle, ChevronDown, Loader2, RefreshCw, Trash2, Zap } from 'lucide-react'
import { post } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'
import { inp, lbl } from './constants'

/** Danger Zone — collapsed by default at the bottom of the General tab.
 *  Owns three destructive actions:
 *    - Pause all syncs (reversible): flips ical + gcal auto-sync flags off
 *    - Unlink calendars (data preserved): clears gcal event ids + iCal feeds
 *    - Reset all data (irreversible): drops every business record row
 *
 *  Takes `{ toast, automationSettings, setAutomationSettings }` — the
 *  "Pause all syncs" action mutates the shared automation state via the
 *  passed setter, so live status stays in sync across tabs. */
export default function DangerZone({ toast, automationSettings, setAutomationSettings }) {
  const [showDangerZone, setShowDangerZone] = useState(false)

  // Pause all syncs
  const [pausing, setPausing] = useState(false)
  const pauseAllSyncs = async () => {
    setPausing(true)
    try {
      const next = { ...automationSettings, ical_auto_sync_enabled: false, gcal_auto_sync_enabled: false }
      await post('/api/settings/automation', next)
      setAutomationSettings(next)
      toast('All auto-syncs paused')
    } catch (e) {
      toast('Failed to pause syncs: ' + (e?.message || 'unknown'), 'error')
    } finally {
      setPausing(false)
    }
  }

  // Unlink calendars
  const [unlinkConfirmText, setUnlinkConfirmText] = useState('')
  const [unlinking, setUnlinking] = useState(false)
  const [unlinkResult, setUnlinkResult] = useState(null)
  const [unlinkClearGcal, setUnlinkClearGcal] = useState(true)
  const [unlinkDeactivateIcal, setUnlinkDeactivateIcal] = useState(true)
  const runUnlinkCalendars = async () => {
    if (unlinkConfirmText !== 'UNLINK') return
    if (!unlinkClearGcal && !unlinkDeactivateIcal) {
      toast('Select at least one option', 'error')
      return
    }
    if (!(await confirmDialog('This will detach BrightBase from Google Calendar and disable iCal feeds. Local jobs/visits/properties remain. Continue?', { confirmLabel: 'Unlink', danger: true }))) return
    setUnlinking(true)
    setUnlinkResult(null)
    try {
      const data = await post('/api/admin/unlink-calendars', {
        confirm: 'UNLINK',
        clear_gcal: unlinkClearGcal,
        deactivate_ical_feeds: unlinkDeactivateIcal,
      })
      setUnlinkResult(data)
      setUnlinkConfirmText('')
      toast(`Unlinked: ${data.jobs_unlinked} jobs, ${data.visits_unlinked} visits, ${data.ical_feeds_deactivated} iCal feeds`)
    } catch (e) {
      setUnlinkResult({ error: e?.message || 'Unlink failed' })
      toast('Unlink failed: ' + (e?.message || 'unknown'), 'error')
    } finally {
      setUnlinking(false)
    }
  }

  // Reset all data
  const [resetConfirmText, setResetConfirmText] = useState('')
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState(null)
  const runResetData = async () => {
    if (resetConfirmText !== 'RESET') return
    if (!(await confirmDialog('This will permanently delete ALL clients, properties, jobs, visits, quotes, invoices, conversations, messages, leads, opportunities, and activities. Users and settings are preserved. Continue?', { confirmLabel: 'Reset all data', danger: true }))) return
    setResetting(true)
    setResetResult(null)
    try {
      const data = await post('/api/admin/reset-data', { confirm: 'RESET' })
      setResetResult(data)
      setResetConfirmText('')
      toast(`Deleted ${data.deleted_total} rows across ${Object.keys(data.deleted_by_table || {}).length} tables`)
    } catch (e) {
      setResetResult({ error: e?.message || 'Reset failed' })
      toast('Reset failed: ' + (e?.message || 'unknown'), 'error')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="pt-8" data-testid="danger-zone">
      <button type="button" onClick={() => setShowDangerZone(v => !v)}
        className="text-lg font-bold text-red-600 mb-2 flex items-center gap-2 hover:text-red-700">
        <AlertTriangle className="w-5 h-5" /> Danger Zone
        <ChevronDown className={`w-4 h-4 transition-transform ${showDangerZone ? 'rotate-180' : ''}`} />
      </button>

      {showDangerZone && (<>

      {/* Pause all syncs (reversible) */}
      <div className="bg-panel rounded-xl border border-amber-200 dark:border-amber-500/25 p-6 space-y-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Pause all syncs</h3>
          <p className="text-xs text-ink-3 mt-1">
            Disables both iCal pull (Airbnb / VRBO → BrightBase) and Google Calendar auto-sync.
            Reversible — re-enable anytime in <strong>Automation</strong>. Use this before a
            cleanup so new bookings/events don't repopulate while you're deleting.
          </p>
        </div>
        <button
          onClick={pauseAllSyncs}
          disabled={pausing || (!automationSettings.ical_auto_sync_enabled && !automationSettings.gcal_auto_sync_enabled)}
          data-testid="pause-syncs-button"
          className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors"
        >
          {pausing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {pausing
            ? 'Pausing...'
            : (!automationSettings.ical_auto_sync_enabled && !automationSettings.gcal_auto_sync_enabled)
              ? 'Already paused'
              : 'Pause all syncs'}
        </button>
      </div>

      {/* Unlink calendars (irreversible — but data preserved) */}
      <div className="bg-panel rounded-xl border border-orange-200 dark:border-orange-500/25 p-6 space-y-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Unlink calendars</h3>
          <p className="text-xs text-ink-3 mt-1">
            Severs the link between BrightBase records and external calendars without
            deleting your data. Use this before a wipe so deleting a job here won't try
            to also delete its event from Google Calendar.
          </p>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={unlinkClearGcal}
              onChange={e => setUnlinkClearGcal(e.target.checked)}
              className="w-4 h-4 rounded border-hairline" />
            Clear <code className="text-[10px] bg-bg-2 px-1 rounded">gcal_event_id</code> on every job and visit
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={unlinkDeactivateIcal}
              onChange={e => setUnlinkDeactivateIcal(e.target.checked)}
              className="w-4 h-4 rounded border-hairline" />
            Deactivate every iCal feed on properties
          </label>
        </div>
        <div>
          <label className={lbl}>Type UNLINK to enable the button</label>
          <input
            type="text"
            value={unlinkConfirmText}
            onChange={e => setUnlinkConfirmText(e.target.value)}
            placeholder="UNLINK"
            data-testid="unlink-confirm-input"
            className={inp}
            autoComplete="off"
          />
        </div>
        <button
          onClick={runUnlinkCalendars}
          disabled={unlinking || unlinkConfirmText !== 'UNLINK'}
          data-testid="unlink-button"
          className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors"
        >
          {unlinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {unlinking ? 'Unlinking...' : 'Unlink calendars'}
        </button>
        {unlinkResult && !unlinkResult.error && (
          <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/25 text-emerald-800 dark:text-emerald-300 rounded-lg p-3 text-xs">
            <div className="font-semibold mb-1">✓ Unlinked</div>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Jobs cleared: {unlinkResult.jobs_unlinked}</li>
              <li>Visits cleared: {unlinkResult.visits_unlinked}</li>
              <li>iCal feeds deactivated: {unlinkResult.ical_feeds_deactivated}</li>
            </ul>
          </div>
        )}
        {unlinkResult?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 rounded-lg p-3 text-xs">
            Unlink failed: {unlinkResult.error}
          </div>
        )}
      </div>

      <div className="bg-panel rounded-xl border border-red-200 dark:border-red-500/25 p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Reset all data</h3>
          <p className="text-xs text-ink-3 mt-1">
            Permanently deletes every client, property, job, visit, quote, invoice,
            conversation, message, lead, opportunity, and activity. Users, custom
            fields, and app settings are preserved. <strong>This cannot be undone.</strong>
          </p>
        </div>
        <div>
          <label className={lbl}>Type RESET to enable the button</label>
          <input
            type="text"
            value={resetConfirmText}
            onChange={e => setResetConfirmText(e.target.value)}
            placeholder="RESET"
            data-testid="reset-confirm-input"
            className={inp}
            autoComplete="off"
          />
        </div>
        <button
          onClick={runResetData}
          disabled={resetting || resetConfirmText !== 'RESET'}
          data-testid="reset-data-button"
          className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors"
        >
          {resetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          {resetting ? 'Deleting...' : 'Reset all data'}
        </button>
        {resetResult && !resetResult.error && (
          <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/25 text-emerald-800 dark:text-emerald-300 rounded-lg p-3 text-xs">
            <div className="font-semibold mb-1">
              ✓ Deleted {resetResult.deleted_total} rows
            </div>
            <ul className="list-disc list-inside space-y-0.5">
              {Object.entries(resetResult.deleted_by_table || {})
                .filter(([, n]) => n > 0)
                .map(([table, n]) => (
                  <li key={table}>{table}: {n}</li>
                ))}
            </ul>
          </div>
        )}
        {resetResult?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 rounded-lg p-3 text-xs">
            Reset failed: {resetResult.error}
          </div>
        )}
      </div>
      </>)}
    </div>
  )
}
