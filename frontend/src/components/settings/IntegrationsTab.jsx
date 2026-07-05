import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, X } from 'lucide-react'
import GoogleAccountCard from '../GoogleAccountCard'
import { get, post } from '../../api'

/** Integrations tab — the "connect BrightBase to Google / your phone /
 *  external tools" hub. Six cards in a stack:
 *    - GoogleAccountCard (per-user grant, always rendered)
 *    - Customer messaging status (read-only + off toggle)
 *    - Google Calendar embed URL
 *    - iCal Turnover Sync (reads automationSettings — shared with Automation)
 *    - Connected Services: GCal live status + write-target matrix
 *    - Gmail per-account health
 *    - Available integrations (Connecteam / Stripe / Zapier placeholders)
 *
 *  Owns its own load state; parent supplies automation state + toast. */
export default function IntegrationsTab({ toast, active, automationSettings, setAutomationSettings }) {
  const [gcalEmbed, setGcalEmbed] = useState('')
  const [gcalEmbedSaving, setGcalEmbedSaving] = useState(false)
  const [gcalConn, setGcalConn] = useState({ loading: true })
  const [gcalConnecting, setGcalConnecting] = useState(false)
  const [gmailConn, setGmailConn] = useState({ loading: true })
  const [msgStatus, setMsgStatus] = useState({ loading: true })
  const [msgSaving, setMsgSaving] = useState(false)
  const [stoppingIcal, setStoppingIcal] = useState(false)
  const [connecteam, setConnecteam] = useState({ loading: true })
  const [ctForm, setCtForm] = useState({ api_key: '', company_id: '', open: false })
  const [ctSaving, setCtSaving] = useState(false)
  const [ctTesting, setCtTesting] = useState(false)
  const [ctPushing, setCtPushing] = useState(false)

  const refreshGcalStatus = () => {
    setGcalConn({ loading: true })
    return get('/api/settings/gcal-status')
      .then(r => setGcalConn({ loading: false, ...r }))
      .catch(e => setGcalConn({ loading: false, connected: false, reason: 'error', detail: e?.message || 'Could not check status' }))
  }

  const refreshGmailStatus = () => {
    setGmailConn({ loading: true })
    return get('/api/settings/gmail-status')
      .then(r => setGmailConn({ loading: false, ...r }))
      .catch(e => setGmailConn({ loading: false, connected: false, accounts: [], detail: e?.message || 'Could not check status' }))
  }

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

  const refreshConnecteamStatus = () => {
    setConnecteam(c => ({ ...c, loading: true }))
    return get('/api/settings/connecteam-status')
      .then(r => {
        setConnecteam({ loading: false, ...r })
        setCtForm(f => ({ ...f, company_id: r.company_id || '' }))
      })
      .catch(e => setConnecteam({ loading: false, configured: false, error: e?.message || 'Could not check status' }))
  }

  useEffect(() => {
    if (!active) return
    get('/api/settings/gcal-embed').then(r => setGcalEmbed(r?.override || '')).catch(() => {})
    refreshGcalStatus()
    refreshGmailStatus()
    refreshConnecteamStatus()
    get('/api/settings/messaging-status')
      .then(r => setMsgStatus({ loading: false, ...r }))
      .catch(() => setMsgStatus({ loading: false, error: true }))
  }, [active])

  const saveConnecteam = async () => {
    setCtSaving(true)
    try {
      const payload = { company_id: ctForm.company_id.trim() }
      // Only send api_key if the user actually typed one — empty means "leave alone".
      if (ctForm.api_key.trim()) payload.api_key = ctForm.api_key.trim()
      const r = await post('/api/settings/connecteam', payload)
      setConnecteam({ loading: false, ...r })
      setCtForm(f => ({ ...f, api_key: '', open: false, company_id: r.company_id || f.company_id }))
      toast('Connecteam credentials saved')
    } catch (e) {
      toast(e?.message || 'Could not save Connecteam credentials', 'error')
    } finally {
      setCtSaving(false)
    }
  }

  const disconnectConnecteam = async () => {
    if (!window.confirm('Disconnect Connecteam? Bright Space will stop pushing shifts until you re-add the API key.')) return
    setCtSaving(true)
    try {
      const r = await post('/api/settings/connecteam', { api_key: '', company_id: '' })
      setConnecteam({ loading: false, ...r })
      setCtForm({ api_key: '', company_id: '', open: false })
      toast('Connecteam disconnected')
    } catch (e) {
      toast(e?.message || 'Could not disconnect Connecteam', 'error')
    } finally {
      setCtSaving(false)
    }
  }

  // testConnecteam({silent: true}) is called automatically when the form opens
  // so the Scheduler ID field is already a real dropdown of the operator's
  // schedulers — no more "hit Test connection first, then re-open the form to
  // pick from the list". A silent call swallows both the success toast and
  // failures (a failed silent probe just leaves the plain input in place).
  const testConnecteam = async ({ silent = false } = {}) => {
    if (!silent) setCtTesting(true)
    try {
      const r = await post('/api/settings/connecteam/test', {})
      setConnecteam(c => ({ ...c, schedulers: r.schedulers || [] }))
      if (!silent) {
        const acct = r.account?.name || r.account?.email || 'Connecteam'
        const n = (r.schedulers || []).length
        toast(`Connecteam OK — connected as ${acct}${n ? ` · ${n} scheduler${n === 1 ? '' : 's'} available` : ''}`)
      }
    } catch (e) {
      if (!silent) toast(e?.message || 'Connecteam test call failed', 'error')
    } finally {
      if (!silent) setCtTesting(false)
    }
  }

  // Auto-populate the scheduler dropdown when the credentials form opens (or
  // opens implicitly because Connecteam isn't configured yet). Only fires when
  // an API key is actually saved — no point probing without one.
  useEffect(() => {
    if (!active) return
    const formVisible = !connecteam.loading && (!connecteam.configured || ctForm.open)
    if (!formVisible) return
    if (!connecteam.has_key) return
    if (Array.isArray(connecteam.schedulers)) return
    testConnecteam({ silent: true })
    // testConnecteam is defined inline above with stable closures; only the
    // form-open trigger + presence of a saved key should re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connecteam.loading, connecteam.configured, ctForm.open, connecteam.has_key])

  const pushScheduleToConnecteam = async () => {
    if (!window.confirm('Push the next 14 days of Bright Space jobs to Connecteam as open shifts?')) return
    setCtPushing(true)
    try {
      const r = await post('/api/settings/connecteam/push-open-shifts', {})
      // Diagnostic toast: the base case ("Pushed 0 · 0 skipped") gave no signal
      // for why nothing went over. Split the message by outcome so the operator
      // knows whether to create jobs, un-dispatch, or check a real error.
      const range = r.range ? ` (${r.range.start_date}→${r.range.end_date})` : ''
      const e0 = r.errors?.[0]
      // Surface Connecteam's actual complaint when it's a 4xx (their response
      // body names the reason — invalid scheduler id, duration too long,
      // etc). Truncate so a huge body doesn't blow up the toast.
      const firstErr = e0
        ? (e0.status
            ? ` — first failure: HTTP ${e0.status}${e0.body ? ` — ${String(e0.body).slice(0, 180)}` : ''}`
            : ` — first failure: ${e0.error}`)
        : ''
      let msg
      let tone
      if (r.pushed > 0) {
        msg = `Pushed ${r.pushed} open shift${r.pushed === 1 ? '' : 's'} to Connecteam · ${r.skipped} skipped${r.errors?.length ? ` · ${r.errors.length} failed` : ''}`
        tone = r.errors?.length ? 'error' : undefined
      } else if (r.considered === 0) {
        msg = `No Bright Space jobs found${range}. Create jobs on the Schedule page first — this endpoint only pushes real jobs, not iCal turnovers that haven't been materialised.`
        tone = 'error'
      } else if (r.errors?.length) {
        msg = `Connecteam rejected all ${r.errors.length} job push${r.errors.length === 1 ? '' : 'es'}${firstErr}`
        tone = 'error'
      } else {
        // considered > 0, pushed = 0, no errors → all skipped
        msg = `All ${r.considered} job${r.considered === 1 ? '' : 's'} in the window were skipped (already dispatched or missing date/time). Nothing to do.`
        tone = 'error'
      }
      toast(msg, tone)
    } catch (e) {
      toast(e?.message || 'Could not push schedule', 'error')
    } finally {
      setCtPushing(false)
    }
  }

  // Returning from Google's consent screen lands here with ?gcal=connected.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('gcal') === 'connected') {
      toast('Google account connected')
      params.delete('gcal')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
      refreshGcalStatus()
    }
  }, [])

  const connectGoogle = async () => {
    setGcalConnecting(true)
    try {
      const r = await get('/api/settings/google/connect')
      if (r?.auth_url) window.location.href = r.auth_url
      else toast('Could not start Google connect', 'error')
    } catch (e) {
      toast(e?.message || 'Could not start Google connect', 'error')
    } finally {
      setGcalConnecting(false)
    }
  }

  const saveGcalEmbed = async () => {
    setGcalEmbedSaving(true)
    try {
      await post('/api/settings/gcal-embed', { embed_url: gcalEmbed })
      toast('Google Calendar embed saved')
    } catch (e) {
      toast(e.message || 'Could not save — must be a Google Calendar embed URL', 'error')
    }
    setGcalEmbedSaving(false)
  }

  const toggleIcalSync = async (enable) => {
    setStoppingIcal(true)
    try {
      const next = { ...automationSettings, ical_auto_sync_enabled: enable }
      await post('/api/settings/automation', { ical_auto_sync_enabled: enable })
      setAutomationSettings(next)
      toast(enable ? 'iCal sync resumed' : 'iCal sync stopped')
    } catch (e) {
      toast('Failed to update iCal sync: ' + (e?.message || 'unknown'), 'error')
    } finally {
      setStoppingIcal(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
      <div className="max-w-2xl pt-6 space-y-8">

        {/* Per-user Google grant (Gmail + Calendar), distinct from the
            shared business connection below. */}
        <GoogleAccountCard />

        {/* Customer messaging status — at-a-glance "are we auto-texting
            customers?". Read-only mirror of the job SMS reminder flag. */}
        {!msgStatus.loading && !msgStatus.error && (
          <div className={`rounded-xl border p-4 flex items-center justify-between gap-3 ${
            msgStatus.any_automatic_customer_messaging
              ? 'bg-amber-50 border-amber-200'
              : 'bg-emerald-50 border-emerald-200'
          }`}>
            <div className="flex items-center gap-3">
              <span className="text-xl">{msgStatus.any_automatic_customer_messaging ? '🔔' : '🔕'}</span>
              <div>
                <h3 className={`text-sm font-semibold ${msgStatus.any_automatic_customer_messaging ? 'text-amber-800' : 'text-emerald-800'}`}>
                  Customer messaging: {msgStatus.any_automatic_customer_messaging ? 'ON' : 'OFF'}
                </h3>
                <p className={`text-xs mt-0.5 ${msgStatus.any_automatic_customer_messaging ? 'text-amber-700' : 'text-emerald-700'}`}>
                  {msgStatus.any_automatic_customer_messaging
                    ? 'Automatic SMS reminders to customers are enabled.'
                    : 'No automatic texts or emails are sent to customers. Invites & invoices are manual only.'}
                </p>
              </div>
            </div>
            {msgStatus.any_automatic_customer_messaging ? (
              <button onClick={() => setMessaging(false)} disabled={msgSaving}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-60 shrink-0">
                {msgSaving ? 'Turning off…' : 'Turn off'}
              </button>
            ) : (
              <span className="px-2.5 py-1 rounded-full text-xs font-medium border bg-emerald-100 text-emerald-700 border-emerald-300 shrink-0">
                Auto-reminders OFF
              </span>
            )}
          </div>
        )}

        {/* Google Calendar embed */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">Google Calendar Embed</h2>
            <p className="text-sm text-ink-2 mt-1">
              Shows your real Google Calendar in the Schedule "Google" view and on each
              client's Calendar tab. Paste the embed URL or the full <code className="text-xs">&lt;iframe&gt;</code> from
              Google Calendar → Settings → "Integrate calendar". Leave blank to auto-build from your
              configured calendar IDs.
            </p>
          </div>
          <div className="bg-panel rounded-xl border border-hairline p-6 space-y-3">
            <textarea
              value={gcalEmbed}
              onChange={e => setGcalEmbed(e.target.value)}
              rows={3}
              placeholder='https://calendar.google.com/calendar/embed?src=…   (or paste the whole <iframe …></iframe>)'
              className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 font-mono focus:outline-none focus:border-blue-400 resize-none"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-ink-3">Only Google Calendar embed URLs are accepted.</span>
              <button onClick={saveGcalEmbed} disabled={gcalEmbedSaving}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50">
                {gcalEmbedSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>

        {/* iCal Turnover Sync */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">iCal Turnover Sync</h2>
            <p className="text-sm text-ink-2 mt-1">
              Pulls Airbnb / VRBO reservations and auto-creates turnover visits.
              Stop the sync to halt all new visits being generated from iCal feeds.
            </p>
          </div>

          <div className="bg-panel rounded-xl border border-hairline p-5 space-y-4" data-testid="ical-sync-card">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl leading-none mt-0.5">🔁</span>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-ink">iCal Sync</h3>
                    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                      automationSettings.ical_auto_sync_enabled
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-bg-2 text-ink-3 border border-hairline'
                    }`}>
                      {automationSettings.ical_auto_sync_enabled ? 'Active' : 'Stopped'}
                    </span>
                  </div>
                  <p className="text-xs text-ink-3 mt-1">
                    {automationSettings.ical_auto_sync_enabled
                      ? `Pulling every ${automationSettings.ical_sync_interval} minutes`
                      : 'Auto-sync paused. No new turnover visits will be created from iCal feeds.'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => toggleIcalSync(!automationSettings.ical_auto_sync_enabled)}
                disabled={stoppingIcal}
                data-testid={automationSettings.ical_auto_sync_enabled ? 'stop-ical-button' : 'resume-ical-button'}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${
                  automationSettings.ical_auto_sync_enabled
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
              >
                {stoppingIcal
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : automationSettings.ical_auto_sync_enabled
                    ? <X className="w-3.5 h-3.5" />
                    : <RefreshCw className="w-3.5 h-3.5" />}
                {stoppingIcal
                  ? 'Working...'
                  : automationSettings.ical_auto_sync_enabled ? 'Stop iCal sync' : 'Resume iCal sync'}
              </button>
            </div>
          </div>
        </div>

        {/* Other connected services */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">Connected Services</h2>
            <p className="text-sm text-ink-2 mt-1">Connect external tools to enhance your workflow</p>
          </div>

          {/* Google Calendar — live status */}
          <div className="bg-panel rounded-xl border border-hairline p-4 mb-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span className="text-2xl">📅</span>
                <div>
                  <h3 className="font-semibold text-ink">Google Calendar</h3>
                  <p className="text-xs text-ink-3">The Google account every appointment is written to & synced from</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
                  gcalConn.loading
                    ? 'bg-bg-2 text-ink-3 border-hairline'
                    : gcalConn.connected
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-red-50 text-red-700 border-red-200'
                }`}>
                  {gcalConn.loading ? 'Checking…' : gcalConn.connected ? '✓ Connected' : '✗ Not connected'}
                </span>
                {!gcalConn.loading && !gcalConn.connected && gcalConn.oauth_available && (
                  <button onClick={connectGoogle} disabled={gcalConnecting}
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 transition-colors">
                    {gcalConnecting ? 'Opening…' : 'Connect Google'}
                  </button>
                )}
              </div>
            </div>
            {!gcalConn.loading && !gcalConn.connected && (
              <div className="mt-3 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 leading-relaxed">
                <div className="font-semibold mb-1">Appointments aren't reaching Google.</div>
                {gcalConn.detail || 'Google Calendar credentials are missing or invalid on the server.'}
                {!gcalConn.oauth_available && (
                  <div className="mt-1 text-[11px]">
                    To enable one-click connect, add a Google "Web" OAuth client on the server
                    (GOOGLE_CREDENTIALS_B64) with redirect URI <code className="bg-red-100 px-1 rounded">/api/settings/google/callback</code>.
                  </div>
                )}
              </div>
            )}
            {!gcalConn.loading && gcalConn.connected && Array.isArray(gcalConn.calendars) && (
              <div className="mt-3 text-[11px] text-ink-3 space-y-1">
                {gcalConn.account_email && (
                  <div>Connected as <code className="bg-bg-2 px-1 rounded text-ink-2">{gcalConn.account_email}</code>
                    {!/mainecleaningco/i.test(gcalConn.account_email) && (
                      <span className="ml-1 text-amber-600 font-medium">— is this your work account?</span>
                    )}
                  </div>
                )}
                <div className="space-y-0.5">
                  <div className="text-ink-3">Where each job type is written:</div>
                  {[
                    { jt: 'residential', label: 'Residential' },
                    { jt: 'commercial', label: 'Commercial' },
                    { jt: 'str_turnover', label: 'Airbnb turnovers' },
                  ].map(({ jt, label }) => {
                    const cal = gcalConn.write_targets?.[jt] || 'primary'
                    const ok = gcalConn.write_targets_ok ? gcalConn.write_targets_ok[jt] !== false : true
                    return (
                      <div key={jt} className="flex items-center gap-1.5">
                        <span className="text-ink-3 w-28 shrink-0">{label}</span>
                        <code className="bg-bg-2 px-1 rounded text-ink-2">{cal}</code>
                        {!ok && <span className="text-red-600 font-medium">— not on this account! Events will fail.</span>}
                      </div>
                    )
                  })}
                </div>
                <div>Visible calendars on this account: {gcalConn.calendars.map(c => c.summary).filter(Boolean).join(', ') || '—'}</div>
                <div className="text-ink-3/80">Tip: the account above must match the calendar you embed below. If you embed office@mainecleaningco.com but are connected as a different account, events won't appear.</div>
              </div>
            )}
          </div>

          {/* Gmail — per-account connection health */}
          <div className="bg-panel rounded-xl border border-hairline p-4 mb-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span className="text-2xl">📧</span>
                <div>
                  <h3 className="font-semibold text-ink">Gmail</h3>
                  <p className="text-xs text-ink-3">Inbound email is synced from connected Google accounts and linked to clients</p>
                </div>
              </div>
              <span className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
                gmailConn.loading
                  ? 'bg-bg-2 text-ink-3 border-hairline'
                  : gmailConn.connected
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-red-50 text-red-700 border-red-200'
              }`}>
                {gmailConn.loading ? 'Checking…' : gmailConn.connected ? '✓ Connected' : '✗ Not connected'}
              </span>
            </div>
            {!gmailConn.loading && Array.isArray(gmailConn.accounts) && gmailConn.accounts.length > 0 && (
              <div className="mt-3 text-[11px] text-ink-3 space-y-1">
                {gmailConn.accounts.map(a => (
                  <div key={a.email} className="flex items-center gap-1.5">
                    <code className="bg-bg-2 px-1 rounded text-ink-2">{a.email}</code>
                    {a.needs_reconnect
                      ? <span className="text-red-600 font-medium">— reconnect needed{a.last_sync_error ? ` (${a.last_sync_error})` : ''}</span>
                      : <span className="text-emerald-600">✓ syncing</span>}
                  </div>
                ))}
              </div>
            )}
            {!gmailConn.loading && (!gmailConn.accounts || gmailConn.accounts.length === 0) && (
              <div className="mt-3 text-[11px] text-ink-3">No Gmail-enabled Google account connected yet. Connect one above to sync inbound email.</div>
            )}
          </div>

          <div className="space-y-3">
            {/* Connecteam — real card. Paste API key + Company ID; test the
                connection; push the upcoming schedule to Connecteam as OPEN
                shifts so cleaners can self-claim them. */}
            <div className="bg-panel rounded-xl border border-hairline p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                  <span className="text-2xl">👥</span>
                  <div>
                    <h3 className="font-semibold text-ink">Connecteam</h3>
                    <p className="text-xs text-ink-3">Push jobs to your field team as open shifts they can claim.</p>
                    {!connecteam.loading && connecteam.configured && (
                      <p className="text-[11px] text-ink-3 mt-1">
                        Key <code className="bg-bg-2 px-1 rounded text-ink-2">{connecteam.api_key_masked}</code>
                        {(connecteam.scheduler_id || connecteam.company_id) ? <> · Scheduler <code className="bg-bg-2 px-1 rounded text-ink-2">{connecteam.scheduler_id || connecteam.company_id}</code></> : null}
                        {connecteam.source === 'env' && <span className="ml-1 text-ink-3">(from server env)</span>}
                      </p>
                    )}
                    {/* Persistent warning: when the backend has a cached
                        scheduler list AND the saved id isn't in it, the
                        Push button will always 400 "schedule id doesn't
                        exist". Surface this on the connected card itself
                        so you don't have to open Update key to know
                        something's off. */}
                    {!connecteam.loading && connecteam.configured && connecteam.scheduler_id_valid === false && Array.isArray(connecteam.schedulers) && connecteam.schedulers.length > 0 && (
                      <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1 mt-2 inline-block">
                        Saved Scheduler ID <code>{connecteam.scheduler_id || connecteam.company_id}</code> isn't on your Connecteam account. Click Update key and pick from the list.
                      </p>
                    )}
                  </div>
                </div>
                <span className={`px-3 py-1.5 rounded-lg text-xs font-medium border shrink-0 ${
                  connecteam.loading
                    ? 'bg-bg-2 text-ink-3 border-hairline'
                    : connecteam.configured
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-bg-2 text-ink-3 border-hairline'
                }`}>
                  {connecteam.loading ? 'Checking…' : connecteam.configured ? '✓ Connected' : 'Not connected'}
                </span>
              </div>

              {/* Form: shown when not connected, or when the user clicks
                  "Update key" on a connected card (so re-keying is one click). */}
              {!connecteam.loading && (!connecteam.configured || ctForm.open) && (
                <div className="mt-4 space-y-3 border-t border-hairline pt-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-2 mb-1">API Key</label>
                    <input
                      type="password"
                      autoComplete="off"
                      value={ctForm.api_key}
                      onChange={e => setCtForm(f => ({ ...f, api_key: e.target.value }))}
                      placeholder={connecteam.has_key ? 'Enter a new key to replace the saved one' : 'Paste your Connecteam API key'}
                      className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 font-mono focus:outline-none focus:border-blue-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-2 mb-1">Scheduler ID</label>
                    {Array.isArray(connecteam.schedulers) && connecteam.schedulers.length > 0 ? (
                      <>
                        <select
                          value={ctForm.company_id}
                          onChange={e => setCtForm(f => ({ ...f, company_id: e.target.value }))}
                          className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400"
                        >
                          <option value="">— pick a scheduler —</option>
                          {connecteam.schedulers.map(s => (
                            <option key={s.id} value={s.id}>{s.name} (ID {s.id})</option>
                          ))}
                        </select>
                        {/* Warn when the currently-selected/saved id doesn't
                            match any scheduler on the account — the mistake
                            that made "rejected 8 pushes" happen the first time
                            (a Company ID got pasted where a Scheduler ID
                            belongs). Empty selection is fine — that's the
                            initial "pick one" state. */}
                        {ctForm.company_id && !connecteam.schedulers.some(s => String(s.id) === String(ctForm.company_id)) && (
                          <p className="text-[11px] text-red-700 mt-1">
                            ID <code className="bg-red-50 px-1 rounded">{ctForm.company_id}</code> isn't one of your schedulers — pick from the list above.
                          </p>
                        )}
                      </>
                    ) : (
                      <input
                        type="text"
                        autoComplete="off"
                        value={ctForm.company_id}
                        onChange={e => setCtForm(f => ({ ...f, company_id: e.target.value }))}
                        placeholder="numeric scheduler id, e.g. 12345"
                        className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 font-mono focus:outline-none focus:border-blue-400"
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-ink-3">
                    Get the API key from Connecteam → <b>Integrations Center → API keys</b>. The Scheduler ID is the numeric id of the specific schedule you want shifts pushed into — save the key first, hit <b>Test connection</b>, and this field turns into a picker of every scheduler on your account.
                  </p>
                  <div className="flex items-center gap-2">
                    <button onClick={saveConnecteam} disabled={ctSaving || (!ctForm.company_id.trim() && !ctForm.api_key.trim())}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50">
                      {ctSaving ? 'Saving…' : 'Save credentials'}
                    </button>
                    {ctForm.open && (
                      <button onClick={() => setCtForm(f => ({ ...f, open: false, api_key: '' }))}
                        className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Actions: shown when connected. Test verifies the saved key
                  against Connecteam; Push sends upcoming jobs as open shifts. */}
              {!connecteam.loading && connecteam.configured && !ctForm.open && (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
                  <button onClick={pushScheduleToConnecteam} disabled={ctPushing}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50">
                    {ctPushing ? 'Pushing…' : 'Push schedule → open shifts'}
                  </button>
                  <button onClick={testConnecteam} disabled={ctTesting}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors disabled:opacity-50">
                    {ctTesting ? 'Testing…' : 'Test connection'}
                  </button>
                  <button onClick={() => setCtForm(f => ({ ...f, open: true, api_key: '' }))}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors">
                    Update key
                  </button>
                  <button onClick={disconnectConnecteam} disabled={ctSaving}
                    className="ml-auto px-3 py-2 rounded-lg text-xs font-medium text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50">
                    Disconnect
                  </button>
                </div>
              )}
            </div>

            {/* Stripe / Zapier — still placeholders. */}
            {[
              { name: 'Stripe', icon: '💳', desc: 'Accept online payments' },
              { name: 'Zapier', icon: '⚡', desc: 'Automate workflows with 5000+ apps' },
            ].map((integration, idx) => (
              <div key={idx} className="bg-panel rounded-xl border border-hairline p-4 flex items-center justify-between hover:shadow-md transition-shadow">
                <div className="flex items-center gap-4">
                  <span className="text-2xl">{integration.icon}</span>
                  <div>
                    <h3 className="font-semibold text-ink">{integration.name}</h3>
                    <p className="text-xs text-ink-3">{integration.desc}</p>
                  </div>
                </div>
                <button className="px-4 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors">
                  Connect
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
