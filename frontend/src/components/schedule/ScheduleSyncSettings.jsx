import { useState, useEffect, useCallback } from 'react'
import { X, Calendar, Home, Repeat, Zap, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'

/**
 * ScheduleSyncSettings — the sync/automation knobs that actually govern the
 * Schedule, surfaced right on the Schedule page (Tools → Sync & automation)
 * instead of buried in Settings, in plain language. Reuses
 * GET/POST /api/settings/automation (partial updates), so no backend change.
 *
 * Deliberately shows ONLY the scheduling-relevant settings (Google live
 * sync, Airbnb import, recurring auto-generate) — the customer-messaging
 * toggles stay in full Settings so this stays uncluttered.
 *
 * Sync is ONE-WAY: BrightBase is the master and pushes the schedule out to
 * Google live. Changes made directly in Google are not pulled back — so
 * there's no "who wins" choice and no drift queue to babysit.
 */

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-indigo-600' : 'bg-bg-3'} ${disabled ? 'opacity-50' : ''}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  )
}

function Row({ icon: Icon, tint, title, desc, children }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <div className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${tint}`}><Icon className="w-4 h-4" /></div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="text-xs text-ink-3 mt-0.5 leading-relaxed">{desc}</div>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  )
}

export default function ScheduleSyncSettings({ open, onClose }) {
  const [s, setS] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    get('/api/settings/automation')
      .then(d => setS(d || {}))
      .catch(() => { setS({}); toast.error('Could not load sync settings') })
      .finally(() => setLoading(false))
  }, [open])

  // Optimistic partial save — the endpoint accepts just the changed field.
  const save = useCallback(async (patch) => {
    setS(prev => ({ ...prev, ...patch }))
    try {
      const res = await post('/api/settings/automation', patch)
      // Turning live sync ON registers Google push channels server-side; a 200
      // can still report it didn't start (no public URL / Google not connected).
      // Warn instead of leaving the toggle looking successfully on.
      if (patch.gcal_live_sync === true && res?.live_sync && res.live_sync.ok === false) {
        toast.error(`Saved, but real-time Google sync couldn't start: ${res.live_sync.error || 'Google not connected or no public URL'}`)
      }
    } catch (e) {
      toast.error(e?.message || 'Could not save — reverting')
      get('/api/settings/automation').then(d => setS(d || {})).catch(() => {})
    }
  }, [])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="Sync & automation settings">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md h-full bg-panel border-l border-hairline shadow-2xl flex flex-col animate-[slidein_.2s_ease]">
        <style>{`@keyframes slidein{from{transform:translateX(24px);opacity:.6}to{transform:none;opacity:1}}`}</style>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-hairline shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-indigo-500" />
            <h2 className="font-semibold text-ink">Sync &amp; automation</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-bg-2 rounded-lg text-ink-3"><X className="w-4.5 h-4.5" /></button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-ink-3">Loading…</div>
        ) : (
          <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-hairline">
            {/* Google Calendar */}
            <div>
              <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Google Calendar</div>
              <div className="flex items-center justify-between">
                <Row icon={Calendar} tint="bg-blue-500/15 text-blue-500"
                  title="Live push to Google"
                  desc="BrightBase is the master: your schedule pushes to Google in real time and stays the source of truth. Edits made directly in Google aren't pulled back. (Needs Google connected.)" />
                <div className="pr-4"><Toggle on={s.gcal_live_sync !== false} onChange={v => save({ gcal_live_sync: v })} /></div>
              </div>
            </div>

            {/* Airbnb / iCal */}
            <div>
              <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Airbnb &amp; rentals</div>
              <div className="flex items-center justify-between">
                <Row icon={Home} tint="bg-amber-500/15 text-amber-500"
                  title="Auto-import turnovers"
                  desc="Pull Airbnb/VRBO checkout calendars and create turnover jobs automatically." />
                <div className="pr-4"><Toggle on={s.ical_auto_sync_enabled !== false} onChange={v => save({ ical_auto_sync_enabled: v })} /></div>
              </div>
            </div>

            {/* Recurring */}
            <div>
              <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Recurring cleanings</div>
              <div className="flex items-center justify-between">
                <Row icon={Repeat} tint="bg-emerald-500/15 text-emerald-500"
                  title="Auto-generate upcoming visits"
                  desc="Keep materializing the next visits for every active recurring series. To pause one specific client, use the Recurring page instead." />
                <div className="pr-4"><Toggle on={s.recurring_auto_generate_enabled !== false} onChange={v => save({ recurring_auto_generate_enabled: v })} /></div>
              </div>
              <div className="px-4 pb-4">
                <Link to="/recurring" onClick={onClose}
                  className="inline-flex items-center gap-1.5 text-xs text-blue-500 hover:underline">
                  Manage recurring series <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            </div>

            <div className="px-4 py-3 text-[11px] text-ink-3">
              Changes save automatically. More options (customer reminders, invites) live in <Link to="/settings" onClick={onClose} className="text-blue-500 hover:underline">Settings → Automation</Link>.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
