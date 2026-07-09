import { useCallback, useEffect, useState } from 'react'
import { CheckCircle, Loader2 } from 'lucide-react'
import { get, post } from '../../api'
import { inp, lbl } from './constants'

/** Automation settings — the sync intervals + auto-generate toggles. State
 *  lives in a hook because Integrations and Danger Zone both read it (for
 *  the iCal Turnover card + the "Pause All Syncs" disabled state). Load
 *  fires whenever the parent tells the hook a relevant section is active. */

export function useAutomationSettings({ toast, active }) {
  const [automationSettings, setAutomationSettings] = useState({
    ical_auto_sync_enabled: true,
    ical_sync_interval: 15,
    gcal_auto_sync_enabled: true,
    gcal_sync_interval: 10,
    recurring_auto_generate_enabled: true,
    invite_customers: true,
    turnover_lead_buffer_hours: 3,
  })
  const [automationSaving, setAutomationSaving] = useState(false)

  const loadAutomationSettings = useCallback(async () => {
    try {
      const data = await get('/api/settings/automation')
      setAutomationSettings(s => ({ ...s, ...data }))
    } catch (err) {
      console.error('[Settings] failed to load automation settings', err)
    }
  }, [])

  useEffect(() => { if (active) loadAutomationSettings() }, [active, loadAutomationSettings])

  const saveAutomationSettings = async () => {
    setAutomationSaving(true)
    try {
      await post('/api/settings/automation', automationSettings)
      toast('Automation settings saved')
    } catch {
      toast('Failed to save automation settings', 'error')
    }
    setAutomationSaving(false)
  }

  return {
    automationSettings, setAutomationSettings,
    automationSaving, saveAutomationSettings,
    loadAutomationSettings,
  }
}

export default function AutomationTab({ state, toast, active }) {
  const { automationSettings: s, setAutomationSettings, automationSaving, saveAutomationSettings } = state

  // Customer messaging (SMS reminders) toggle used to live on the Integrations
  // tab as a big amber banner — but it's an automation switch, not an
  // integration. Owns its own state here; reads GET messaging-status and
  // POSTs messaging.
  const [msgStatus, setMsgStatus] = useState({ loading: true })
  const [msgSaving, setMsgSaving] = useState(false)
  useEffect(() => {
    if (!active) return
    get('/api/settings/messaging-status')
      .then(r => setMsgStatus({ loading: false, ...r }))
      .catch(() => setMsgStatus({ loading: false, error: true }))
  }, [active])
  const setMessaging = async (on) => {
    setMsgSaving(true)
    try {
      const r = await post('/api/settings/messaging', { customer_sms_reminders: on })
      setMsgStatus({ loading: false, ...r })
      toast(on ? 'Automatic SMS reminders enabled' : 'Automatic customer messaging turned OFF')
    } catch (e) {
      toast(e?.message || 'Could not update messaging', 'error')
    } finally {
      setMsgSaving(false)
    }
  }
  const setDunning = async (on) => {
    setMsgSaving(true)
    try {
      const r = await post('/api/settings/messaging', { invoice_dunning: on })
      setMsgStatus({ loading: false, ...r })
      toast(on ? 'Automatic overdue-invoice reminders enabled' : 'Automatic overdue-invoice reminders turned OFF')
    } catch (e) {
      toast(e?.message || 'Could not update dunning', 'error')
    } finally {
      setMsgSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
      <div className="max-w-2xl pt-6">
        <div className="mb-6">
          <h2 className="text-lg font-bold text-ink">Auto-Sync Settings</h2>
          <p className="text-sm text-ink-2 mt-1">Configure how often your calendar and feeds sync automatically</p>
        </div>

        <div className="bg-panel rounded-xl border border-hairline p-6 space-y-6">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-ink">iCal Auto-Sync</h3>
                <p className="text-xs text-ink-3 mt-1">Sync iCal feeds to your schedule</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.ical_auto_sync_enabled}
                  onChange={e => setAutomationSettings(x => ({ ...x, ical_auto_sync_enabled: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
            {s.ical_auto_sync_enabled && (
              <div className="mt-3">
                <label className={lbl}>Sync Interval (minutes)</label>
                <input type="number" min="5" max="240" value={s.ical_sync_interval}
                  onChange={e => setAutomationSettings(x => ({ ...x, ical_sync_interval: parseInt(e.target.value) || 15 }))}
                  className={inp} />
                <p className="text-xs text-ink-3 mt-1">Recommended: 15 minutes</p>
              </div>
            )}
          </div>

          <div className="border-t border-hairline pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-ink">Google Calendar Auto-Sync</h3>
                <p className="text-xs text-ink-3 mt-1">Sync jobs to your Google Calendar</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.gcal_auto_sync_enabled}
                  onChange={e => setAutomationSettings(x => ({ ...x, gcal_auto_sync_enabled: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
            {s.gcal_auto_sync_enabled && (
              <div className="mt-3">
                <label className={lbl}>Sync Interval (minutes)</label>
                <input type="number" min="5" max="240" value={s.gcal_sync_interval}
                  onChange={e => setAutomationSettings(x => ({ ...x, gcal_sync_interval: parseInt(e.target.value) || 10 }))}
                  className={inp} />
                <p className="text-xs text-ink-3 mt-1">Recommended: 10 minutes</p>
              </div>
            )}
          </div>

          <div className="border-t border-hairline pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-ink">Recurring Jobs Auto-Generate</h3>
                <p className="text-xs text-ink-3 mt-1">Auto-create scheduled jobs from active recurring schedules every day. Backfills missed dates so you never run out of upcoming jobs.</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.recurring_auto_generate_enabled}
                  onChange={e => setAutomationSettings(x => ({ ...x, recurring_auto_generate_enabled: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
            {s.recurring_auto_generate_enabled && (
              <p className="text-xs text-ink-3 mt-1">Runs once every 24 hours. Override per schedule via the Pause button on the Schedule → Recurring tab.</p>
            )}
          </div>

          <div className="border-t border-hairline pt-6">
            <h3 className="font-semibold text-ink">Turnover lead-time guardrail</h3>
            <p className="text-xs text-ink-3 mt-1">
              Flag an Airbnb/VRBO turnover as a "tight turnaround" when it ends
              less than this many hours before the next guest's check-in
              (same-day turnovers are always flagged regardless of this
              setting).
            </p>
            <div className="mt-3 max-w-[200px]">
              <label className={lbl}>Buffer (hours)</label>
              <input type="number" min="0" max="48" step="0.5" value={s.turnover_lead_buffer_hours}
                onChange={e => setAutomationSettings(x => ({ ...x, turnover_lead_buffer_hours: parseFloat(e.target.value) || 0 }))}
                className={inp} />
              <p className="text-xs text-ink-3 mt-1">Recommended: 3 hours</p>
            </div>
          </div>

          {/* Customer messaging status — was a red/amber banner on Integrations.
              Same POST target as before (/api/settings/messaging), just
              relocated to where operators actually look for automation
              toggles. */}
          {!msgStatus.loading && !msgStatus.error && (
            <div className="border-t border-hairline pt-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-ink">Automatic customer SMS reminders</h3>
                  <p className="text-xs text-ink-3 mt-1">
                    {msgStatus.customer_sms_reminders
                      ? 'Currently ON — customers receive automatic SMS reminders before their cleanings.'
                      : 'Currently OFF — no automatic reminder texts are sent to customers. Manual sends are unaffected.'}
                  </p>
                  {/* env_disabled means the deployment set
                      JOB_SMS_REMINDERS_ENABLED=0 as a hard kill. The DB toggle
                      won't take effect until an operator lifts that. Surface
                      the reason so Meg doesn't wonder why flipping the switch
                      doesn't do anything. */}
                  {msgStatus.env_disabled && (
                    <p className="text-xs text-amber-700 mt-1.5 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                      Deployment kill-switch is active
                      (<code className="text-[10px]">JOB_SMS_REMINDERS_ENABLED=0</code>). Ask
                      your ops contact to lift it before this toggle takes effect.
                    </p>
                  )}
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!msgStatus.customer_sms_reminders}
                    disabled={msgSaving || msgStatus.env_disabled}
                    onChange={e => setMessaging(e.target.checked)}
                    className="w-4 h-4 rounded" />
                </label>
              </div>
              {/* Invoice dunning — same shape as SMS reminders. T-03. */}
              <div className="flex items-center justify-between mt-6 pt-6 border-t border-hairline">
                <div>
                  <h3 className="font-semibold text-ink">Automatic overdue-invoice reminders</h3>
                  <p className="text-xs text-ink-3 mt-1">
                    {msgStatus.invoice_dunning
                      ? 'Currently ON — customers with past-due invoices are automatically emailed at 1, 7, and 14 days overdue.'
                      : 'Currently OFF — overdue invoices are not chased automatically.'}
                  </p>
                  {msgStatus.invoice_dunning_env_disabled && (
                    <p className="text-xs text-amber-700 mt-1.5 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                      Deployment kill-switch is active
                      (<code className="text-[10px]">JOB_DUNNING_ENABLED=0</code>). Ask your ops
                      contact to lift it before this toggle takes effect.
                    </p>
                  )}
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!msgStatus.invoice_dunning}
                    disabled={msgSaving || msgStatus.invoice_dunning_env_disabled}
                    onChange={e => setDunning(e.target.checked)}
                    className="w-4 h-4 rounded" />
                </label>
              </div>
            </div>
          )}

          <div className="border-t border-hairline pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-ink">Invite customers to their cleanings</h3>
                <p className="text-xs text-ink-3 mt-1">Add the customer (by email) to each cleaning's Google Calendar event, so they get an invite and see all their upcoming cleanings on their own calendar. Their copy never shows gate codes, crew, or internal notes.</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.invite_customers}
                  onChange={e => setAutomationSettings(x => ({ ...x, invite_customers: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
            {s.invite_customers && (
              <p className="text-xs text-ink-3 mt-1">Applies to new cleanings and to the Calendar page's “Push to Google” backfill (which emails each client an invite for their upcoming cleanings). Only clients with an email on file are invited.</p>
            )}
          </div>
        </div>

        <button onClick={saveAutomationSettings} disabled={automationSaving}
          className="mt-6 flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
          {automationSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Save Changes
        </button>
      </div>
    </div>
  )
}
