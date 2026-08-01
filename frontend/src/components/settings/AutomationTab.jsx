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
    notify_customers: true,
    gcal_reminders_mode: 'google_default',
    calendar_source_of_truth: 'brightbase',
    gcal_live_sync: true,
    connecteam_auto_dispatch_enabled: true,
    connecteam_auto_create_jobs_enabled: true,
    customer_self_reschedule: true,
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
      const res = await post('/api/settings/automation', automationSettings)
      // When real-time sync was just turned on, the backend registers Google
      // push channels and reports whether it worked — surface that so the
      // operator isn't left thinking it's live when Google rejected it.
      if (res?.live_sync && res.live_sync.ok === false) {
        toast(`Saved, but real-time sync couldn't start: ${res.live_sync.error || 'Google not connected / no public URL'}`, 'error')
      } else if (res?.live_sync) {
        toast('Automation settings saved — real-time sync connected')
      } else {
        toast('Automation settings saved')
      }
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
      <div className="max-w-2xl pt-5">
        <div className="mb-5">
          <h2 className="text-lg font-bold text-ink">Auto-Sync Settings</h2>
          <p className="text-sm text-ink-2 mt-1">Configure how often your calendar and feeds sync automatically</p>
        </div>

        <div className="bg-panel rounded-xl border border-hairline p-5 space-y-5">
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

          <div className="border-t border-hairline pt-5">
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
                <input type="number" min="2" max="240" value={s.gcal_sync_interval}
                  onChange={e => setAutomationSettings(x => ({ ...x, gcal_sync_interval: parseInt(e.target.value) || 10 }))}
                  className={inp} />
                <p className="text-xs text-ink-3 mt-1">How often BrightBase polls Google for changes made there. Lower = fresher, more API calls. Turn on “Real-time sync” below to skip polling entirely.</p>
              </div>
            )}
          </div>

          <div className="border-t border-hairline pt-5">
            <div className="mb-3">
              <h3 className="font-semibold text-ink">Two-way sync</h3>
              <p className="text-xs text-ink-3 mt-1">Who wins when the same appointment differs between BrightBase and Google. Cancellations always sync both ways either way.</p>
            </div>
            <select value={s.calendar_source_of_truth}
              onChange={e => setAutomationSettings(x => ({ ...x, calendar_source_of_truth: e.target.value }))}
              className="w-full sm:w-96 bg-bg-2 border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400">
              <option value="brightbase">BrightBase is the master (recommended) — edits made in Google are re-asserted</option>
              <option value="google">Two-way — a time/title edit made in Google syncs back into BrightBase</option>
            </select>
            {s.calendar_source_of_truth === 'google' && (
              <p className="text-xs text-amber-600 mt-2">Two-way is on: moving an appointment in Google Calendar will move the BrightBase job to match. Be careful — a stray drag in Google will move a real job.</p>
            )}
          </div>

          <div className="border-t border-hairline pt-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="font-semibold text-ink">Real-time sync (Google → BrightBase)</h3>
                <p className="text-xs text-ink-3 mt-1">When ON, BrightBase gets a live push from Google the moment something changes there, so edits reflect in seconds instead of on the poll interval above. Needs Google connected and a public app URL. When OFF, the poll interval above is used.</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.gcal_live_sync}
                  onChange={e => setAutomationSettings(x => ({ ...x, gcal_live_sync: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
          </div>

          <div className="border-t border-hairline pt-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="font-semibold text-ink">Live push to Connecteam</h3>
                <p className="text-xs text-ink-3 mt-1">When ON (default), building the schedule in BrightBase pushes shifts to Connecteam automatically as <strong>drafts</strong> — Airbnb turnovers and not-yet-assigned jobs go out as <strong>open</strong> shifts, assigned jobs go to that cleaner. Nothing hits a cleaner’s live schedule until you publish the drafts in Connecteam. Turn OFF for manual mode (push each job with “Dispatch”). Rescheduling an already-pushed job always re-syncs its shift.</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.connecteam_auto_dispatch_enabled}
                  onChange={e => setAutomationSettings(x => ({ ...x, connecteam_auto_dispatch_enabled: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
            {!s.connecteam_auto_dispatch_enabled && (
              <p className="text-xs text-amber-600 mt-1">Manual mode — nothing reaches Connecteam until you dispatch each job yourself.</p>
            )}
            {s.connecteam_auto_dispatch_enabled && (
              <div className="mt-3 pl-3 border-l-2 border-hairline">
                <label className="flex items-center justify-between gap-2 cursor-pointer">
                  <div>
                    <span className="text-sm font-medium text-ink">Create the Connecteam Job if it doesn’t exist</span>
                    <p className="text-xs text-ink-3 mt-1">When a job’s client/property has no matching Job in Connecteam’s Jobs list, create one (named after the property, else the client) and link the shift to it — so a brand-new client lands under its own Job instead of a blank address. Turn OFF to only match existing Jobs and never write to the Jobs list.</p>
                  </div>
                  <input type="checkbox" checked={s.connecteam_auto_create_jobs_enabled}
                    onChange={e => setAutomationSettings(x => ({ ...x, connecteam_auto_create_jobs_enabled: e.target.checked }))}
                    className="w-4 h-4 rounded shrink-0" />
                </label>
              </div>
            )}
          </div>

          <div className="border-t border-hairline pt-5">
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
              <p className="text-xs text-ink-3 mt-1">Runs once every 24 hours. Override per schedule via the Pause button on the Recurring page.</p>
            )}
          </div>

          <div className="border-t border-hairline pt-5">
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
            <div className="border-t border-hairline pt-5">
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
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-1.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-md px-2 py-1.5">
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
              <div className="flex items-center justify-between mt-6 pt-5 border-t border-hairline">
                <div>
                  <h3 className="font-semibold text-ink">Automatic overdue-invoice reminders</h3>
                  <p className="text-xs text-ink-3 mt-1">
                    {msgStatus.invoice_dunning
                      ? 'Currently ON — customers with past-due invoices are automatically emailed at 1, 7, and 14 days overdue.'
                      : 'Currently OFF — overdue invoices are not chased automatically.'}
                  </p>
                  {msgStatus.invoice_dunning_env_disabled && (
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-1.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-md px-2 py-1.5">
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

          <div className="border-t border-hairline pt-5">
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

          <div className="border-t border-hairline pt-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-ink">Email customers when a cleaning changes</h3>
                <p className="text-xs text-ink-3 mt-1">When ON, Google emails the customer when their cleaning is booked, moved, or cancelled (and their calendar copy updates either way). Turn OFF to cut the email noise — the cleaning still lands on their calendar, they just don't get a change email every time. Reschedules now correctly keep the customer on the invite instead of dropping it.</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.notify_customers}
                  onChange={e => setAutomationSettings(x => ({ ...x, notify_customers: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
          </div>

          <div className="border-t border-hairline pt-5">
            <div className="mb-2">
              <h3 className="font-semibold text-ink">Calendar reminders</h3>
              <p className="text-xs text-ink-3 mt-1">How the reminders on each cleaning's Google Calendar event are set. “Use Google Calendar's settings” hands reminder control to Google (change them once in your Google Calendar and they apply everywhere) — recommended, since you're already managing reminders there. “No reminders” puts none on the event. “Email 24h + popup 1h” sets those two explicitly.</p>
            </div>
            <select value={s.gcal_reminders_mode}
              onChange={e => setAutomationSettings(x => ({ ...x, gcal_reminders_mode: e.target.value }))}
              className="w-full sm:w-80 bg-bg-2 border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400">
              <option value="google_default">Use Google Calendar's settings (recommended)</option>
              <option value="off">No reminders</option>
              <option value="email_popup">Email 24h + popup 1h before</option>
            </select>
          </div>

          <div className="border-t border-hairline pt-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-ink">Let customers reschedule themselves</h3>
                <p className="text-xs text-ink-3 mt-1">From the confirm link in their reminder, a customer can pick a new open day and arrival window and move their own visit — the job moves and the calendar updates automatically, and you get an alert. Open days come from your cleaner availability and, when Google Calendar is connected, its free/busy. Off = they can only send a reschedule request for you to action by hand.</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={s.customer_self_reschedule}
                  onChange={e => setAutomationSettings(x => ({ ...x, customer_self_reschedule: e.target.checked }))}
                  className="w-4 h-4 rounded" />
              </label>
            </div>
          </div>
        </div>

        <button onClick={saveAutomationSettings} disabled={automationSaving}
          className="mt-6 flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
          {automationSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Save Changes
        </button>
      </div>
    </div>
  )
}
