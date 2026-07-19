import { useEffect, useState } from 'react'
import GoogleAccountCard from '../GoogleAccountCard'
import { get, post } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'

/** Integrations tab — the "connect BrightBase to Google / your phone /
 *  external tools" hub, reorganized into two sections:
 *    - Google        — GoogleAccountCard (per-user grant) + business GCal
 *                      status with the embed URL inline + Gmail per-account health.
 *    - Other         — Connecteam (paste key, test, push open shifts),
 *                      plus "Coming soon" chips for Stripe / Zapier.
 *
 *  Customer-messaging toggle and iCal Turnover Sync used to live here too but
 *  they're automation switches, not integrations — moved to AutomationTab. */
export default function IntegrationsTab({ toast, active }) {
  const [gcalEmbed, setGcalEmbed] = useState('')
  const [gcalEmbedSaving, setGcalEmbedSaving] = useState(false)
  const [gcalConn, setGcalConn] = useState({ loading: true })
  const [gcalConnecting, setGcalConnecting] = useState(false)
  const [gmailConn, setGmailConn] = useState({ loading: true })
  const [connecteam, setConnecteam] = useState({ loading: true })
  const [ctForm, setCtForm] = useState({ api_key: '', company_id: '', timeclock_id: '', open: false })
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

  const refreshConnecteamStatus = () => {
    setConnecteam(c => ({ ...c, loading: true }))
    return get('/api/settings/connecteam-status')
      .then(r => {
        setConnecteam({ loading: false, ...r })
        setCtForm(f => ({ ...f, company_id: r.company_id || '', timeclock_id: r.timeclock_id || '' }))
      })
      .catch(e => setConnecteam({ loading: false, configured: false, error: e?.message || 'Could not check status' }))
  }

  useEffect(() => {
    if (!active) return
    get('/api/settings/gcal-embed').then(r => setGcalEmbed(r?.override || '')).catch(() => {})
    refreshGcalStatus()
    refreshGmailStatus()
    refreshConnecteamStatus()
  }, [active])

  const saveConnecteam = async () => {
    setCtSaving(true)
    try {
      const payload = { company_id: ctForm.company_id.trim(), timeclock_id: ctForm.timeclock_id.trim() }
      // Only send api_key if the user actually typed one — empty means "leave alone".
      if (ctForm.api_key.trim()) payload.api_key = ctForm.api_key.trim()
      const r = await post('/api/settings/connecteam', payload)
      setConnecteam({ loading: false, ...r })
      setCtForm(f => ({ ...f, api_key: '', open: false, company_id: r.company_id || f.company_id, timeclock_id: r.timeclock_id || f.timeclock_id }))
      toast('Connecteam credentials saved')
    } catch (e) {
      toast(e?.message || 'Could not save Connecteam credentials', 'error')
    } finally {
      setCtSaving(false)
    }
  }

  const disconnectConnecteam = async () => {
    if (!(await confirmDialog('Disconnect Connecteam? BrightBase will stop pushing shifts until you re-add the API key.', { confirmLabel: 'Disconnect', danger: true }))) return
    setCtSaving(true)
    try {
      const r = await post('/api/settings/connecteam', { api_key: '', company_id: '' })
      setConnecteam({ loading: false, ...r })
      setCtForm({ api_key: '', company_id: '', timeclock_id: '', open: false })
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

  // Push now returns 202 + a run_id immediately (T-20 Part B) — the actual
  // bulk Connecteam POST runs as a background task server-side, so this
  // polls for the result instead of holding the request open for minutes
  // (that used to hang the button with zero feedback).
  const pollPushRun = async (runId) => {
    for (let i = 0; i < 120; i++) { // ~3 min ceiling
      const r = await get(`/api/settings/connecteam/push-open-shifts/${runId}`)
      if (r.status === 'done' || r.status === 'error') return r
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    return { status: 'timeout' }
  }

  const pushScheduleToConnecteam = async () => {
    if (!(await confirmDialog('Push the next 14 days of BrightBase jobs to Connecteam as open shifts?', { confirmLabel: 'Push' }))) return
    setCtPushing(true)
    try {
      const kicked = await post('/api/settings/connecteam/push-open-shifts', {})
      const r = await pollPushRun(kicked.run_id)

      if (r.status === 'error') {
        toast(r.error || 'Connecteam push failed — check server logs for the underlying error.', 'error')
        return
      }
      if (r.status === 'timeout') {
        toast('Push is still running in the background — check Connecteam directly, or try again shortly.', 'error')
        return
      }

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
        msg = `No BrightBase jobs found${range}. Create jobs on the Schedule page first — this endpoint only pushes real jobs, not iCal turnovers that haven't been materialised.`
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

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
      <div className="max-w-2xl pt-6 space-y-6">

        {/* One unified "Google" section: per-user account grant (Gmail +
            Calendar) on top; below it the shared business Google Calendar
            connection with its embed-URL configurator inline; below that the
            per-account Gmail health readout. Previously these were three
            separate top-level sections (plus a stray "iCal sync" card and a
            customer-messaging banner) which made the page feel scattered.
            iCal sync + customer messaging moved to the Automation tab. */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">Google</h2>
            <p className="text-sm text-ink-2 mt-1">Per-user Gmail + Calendar grant, plus the shared business calendar the app writes to.</p>
          </div>

          {/* Per-user Google grant (Gmail + Calendar). */}
          <GoogleAccountCard />

          {/* Business Google Calendar — live status + embed URL config
              (inline, since the embed URL is what the calendar status card
              is configuring). */}
          <div className="bg-panel rounded-xl border border-hairline p-4 mb-3 mt-4">
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
                      ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/25'
                      : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 border-red-200 dark:border-red-500/25'
                }`}>
                  {gcalConn.loading ? 'Checking…' : gcalConn.connected ? '✓ Connected' : '✗ Not connected'}
                </span>
                {!gcalConn.loading && !gcalConn.connected && gcalConn.oauth_available && (
                  <button onClick={connectGoogle} disabled={gcalConnecting}
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60 transition-colors">
                    {gcalConnecting ? 'Opening…' : 'Connect Google'}
                  </button>
                )}
              </div>
            </div>
            {!gcalConn.loading && !gcalConn.connected && (
              <div className="mt-3 text-xs bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 rounded-lg p-3 leading-relaxed">
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

            {/* Embed URL configurator — inline so operators immediately see
                the connection status AND the field that changes what the
                Schedule "Google" view actually renders. Was a separate
                top-level section before. */}
            <div className="mt-4 pt-4 border-t border-hairline">
              <div className="text-xs font-semibold text-ink-2 mb-2">Embed URL for the in-app Google view</div>
              <textarea
                value={gcalEmbed}
                onChange={e => setGcalEmbed(e.target.value)}
                rows={2}
                placeholder='https://calendar.google.com/calendar/embed?src=…   (or paste the whole <iframe …></iframe>)'
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-xs text-ink placeholder-ink-3 font-mono focus:outline-none focus:border-blue-400 resize-none"
              />
              <div className="flex items-center justify-between gap-2 mt-2">
                <span className="text-[11px] text-ink-3">Leave blank to auto-build from your configured calendar IDs. Only Google Calendar embed URLs are accepted.</span>
                <button onClick={saveGcalEmbed} disabled={gcalEmbedSaving}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 shrink-0">
                  {gcalEmbedSaving ? 'Saving…' : 'Save embed'}
                </button>
              </div>
            </div>
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
                    ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/25'
                    : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 border-red-200 dark:border-red-500/25'
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
        </div>

        {/* Other integrations — the field-team + payment stack. */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">Other integrations</h2>
            <p className="text-sm text-ink-2 mt-1">Push jobs to your field team, take payments, and hook into external workflows.</p>
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
                      <p className="text-[11px] text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/25 rounded-md px-2 py-1 mt-2 inline-block">
                        Saved Scheduler ID <code>{connecteam.scheduler_id || connecteam.company_id}</code> isn't on your Connecteam account. Click Update key and pick from the list.
                      </p>
                    )}
                  </div>
                </div>
                <span className={`px-3 py-1.5 rounded-lg text-xs font-medium border shrink-0 ${
                  connecteam.loading
                    ? 'bg-bg-2 text-ink-3 border-hairline'
                    : connecteam.configured
                      ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/25'
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
                          <p className="text-[11px] text-red-700 dark:text-red-300 mt-1">
                            ID <code className="bg-red-50 dark:bg-red-500/10 px-1 rounded">{ctForm.company_id}</code> isn't one of your schedulers — pick from the list above.
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
                  <div>
                    <label className="block text-xs font-medium text-ink-2 mb-1">Time Clock ID <span className="text-ink-3 font-normal">(payroll)</span></label>
                    {Array.isArray(connecteam.timeclocks) && connecteam.timeclocks.length > 0 ? (
                      <select
                        value={ctForm.timeclock_id}
                        onChange={e => setCtForm(f => ({ ...f, timeclock_id: e.target.value }))}
                        className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400"
                      >
                        <option value="">— auto (first time clock) —</option>
                        {connecteam.timeclocks.map(tc => (
                          <option key={tc.id} value={tc.id}>{tc.name} (ID {tc.id})</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        autoComplete="off"
                        value={ctForm.timeclock_id}
                        onChange={e => setCtForm(f => ({ ...f, timeclock_id: e.target.value }))}
                        placeholder="leave blank to auto-pick, or a numeric time clock id"
                        className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 font-mono focus:outline-none focus:border-blue-400"
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-ink-3">
                    Get the API key from Connecteam → <b>Integrations Center → API keys</b>. The Scheduler ID is the schedule shifts are pushed into; the Time Clock ID is the clock whose punches drive <b>Payroll</b> (leave it on auto if you only have one). Save the key first, hit <b>Test connection</b>, and both fields turn into pickers of what's on your account.
                  </p>
                  <div className="flex items-center gap-2">
                    <button onClick={saveConnecteam} disabled={ctSaving || (!ctForm.company_id.trim() && !ctForm.api_key.trim())}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50">
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
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50">
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
                    className="ml-auto px-3 py-2 rounded-lg text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 transition-colors disabled:opacity-50">
                    Disconnect
                  </button>
                </div>
              )}
            </div>

            <SquareCard toast={toast} active={active} />

            {/* Stripe / Zapier — not built yet. The "Connect" button here
                used to be an orphaned <button> with no onClick — clicking it
                did literally nothing, which set operators up to click and
                click waiting for a modal that would never appear (same
                disease the pre-#441 Connecteam button had). Downgraded to
                a "Coming soon" chip so the roadmap is visible without
                looking like a live action. */}
            {[
              { name: 'Stripe', icon: '💳', desc: 'Accept online payments' },
              { name: 'Zapier', icon: '⚡', desc: 'Automate workflows with 5000+ apps' },
            ].map((integration, idx) => (
              <div key={idx} className="bg-panel rounded-xl border border-hairline p-4 flex items-center justify-between opacity-70">
                <div className="flex items-center gap-4">
                  <span className="text-2xl">{integration.icon}</span>
                  <div>
                    <h3 className="font-semibold text-ink">{integration.name}</h3>
                    <p className="text-xs text-ink-3">{integration.desc}</p>
                  </div>
                </div>
                <span className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-2 text-ink-3 border border-hairline">
                  Coming soon
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Square — paste an access token, pick a location, test. Enables the Payroll
// page's "Send to Square" (creates Labor API timecards Square Payroll imports).
function SquareCard({ toast, active }) {
  const [st, setSt] = useState({ loading: true })
  const [form, setForm] = useState({ access_token: '', location_id: '', environment: 'production', open: false,
    job_residential: 'Residential', job_rental: 'Rental', job_weekend: 'Rate Pay' })
  const [busy, setBusy] = useState('')

  const refresh = () => {
    setSt(s => ({ ...s, loading: true }))
    return get('/api/settings/square-status')
      .then(r => {
        setSt({ loading: false, ...r })
        const j = r.jobs || {}
        setForm(f => ({ ...f, location_id: r.location_id || '', environment: r.environment || 'production',
          job_residential: j.residential || 'Residential', job_rental: j.rental || 'Rental', job_weekend: j.weekend || 'Rate Pay' }))
      })
      .catch(e => setSt({ loading: false, configured: false, error: e?.message || 'Could not check status' }))
  }
  useEffect(() => { if (active) refresh() }, [active])

  const save = async () => {
    setBusy('save')
    try {
      const payload = { location_id: form.location_id.trim(), environment: form.environment,
        job_residential: form.job_residential.trim(), job_rental: form.job_rental.trim(), job_weekend: form.job_weekend.trim() }
      if (form.access_token.trim()) payload.access_token = form.access_token.trim()
      const r = await post('/api/settings/square', payload)
      setSt({ loading: false, ...r })
      setForm(f => ({ ...f, access_token: '', open: false, location_id: r.location_id || f.location_id }))
      toast('Square settings saved')
    } catch (e) { toast(e?.detail || e?.message || 'Could not save Square settings', 'error') }
    finally { setBusy('') }
  }

  const test = async () => {
    setBusy('test')
    try {
      const r = await post('/api/settings/square/test', {})
      setSt(s => ({ ...s, locations: r.locations || [] }))
      toast(`Square OK — ${r.locations?.length || 0} location${r.locations?.length === 1 ? '' : 's'}, ${r.team_count || 0} team members`)
    } catch (e) { toast(e?.detail || e?.message || 'Square test failed', 'error') }
    finally { setBusy('') }
  }

  const formVisible = !st.loading && (!st.configured || form.open)
  const locations = Array.isArray(st.locations) ? st.locations : []

  return (
    <div className="bg-panel rounded-xl border border-hairline p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-2xl">◼️</span>
          <div>
            <h3 className="font-semibold text-ink">Square Payroll</h3>
            <p className="text-xs text-ink-3">
              {!st.loading && st.configured
                ? <>Token {st.token_masked} · {st.environment}{st.location_id ? ` · location ${st.location_id}` : ''}</>
                : 'Send payroll hours to Square as timecards'}
            </p>
          </div>
        </div>
        <span className={`px-3 py-1.5 rounded-full text-[11px] font-medium border ${st.loading ? 'bg-bg-2 text-ink-3 border-hairline' : st.configured ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' : 'bg-bg-2 text-ink-3 border-hairline'}`}>
          {st.loading ? 'Checking…' : st.configured ? '✓ Connected' : 'Not connected'}
        </span>
      </div>

      {formVisible && (
        <div className="mt-4 space-y-3 border-t border-hairline pt-4">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Access Token</label>
            <input type="password" autoComplete="off" value={form.access_token}
              onChange={e => setForm(f => ({ ...f, access_token: e.target.value }))}
              placeholder={st.has_token ? 'Enter a new token to replace the saved one' : 'Paste your Square access token'}
              className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 font-mono focus:outline-none focus:border-blue-400" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-ink-2 mb-1">Location</label>
              {locations.length > 0 ? (
                <select value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400">
                  <option value="">— pick a location —</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
                </select>
              ) : (
                <input type="text" value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}
                  placeholder="location id — or hit Test to load a picker"
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 font-mono focus:outline-none focus:border-blue-400" />
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Environment</label>
              <select value={form.environment} onChange={e => setForm(f => ({ ...f, environment: e.target.value }))}
                className="bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400">
                <option value="production">Production</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Square job titles to tag timecards with</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                ['job_residential', 'Residential hours'],
                ['job_rental', 'Rental hours'],
                ['job_weekend', 'Weekend rate pay'],
              ].map(([key, lbl]) => (
                <div key={key}>
                  <div className="text-[10.5px] text-ink-3 mb-0.5">{lbl}</div>
                  <input type="text" list="square-job-titles" value={form[key]}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-bg border border-hairline rounded-lg px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:border-blue-400" />
                </div>
              ))}
            </div>
            {Array.isArray(st.job_titles) && st.job_titles.length > 0 && (
              <datalist id="square-job-titles">
                {st.job_titles.map(t => <option key={t} value={t} />)}
              </datalist>
            )}
            <p className="text-[10.5px] text-ink-3 mt-1">
              Match these to the wage jobs on your Square employees so hours land in the right bucket. Hit Test connection to load your Square job titles as suggestions.
            </p>
          </div>
          <p className="text-[11px] text-ink-3">
            Get an access token from the <b>Square Developer dashboard</b> (an app with Timecards + Team read/write). Save the token, hit <b>Test connection</b>, then pick your location.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={busy === 'save' || (!form.access_token.trim() && !st.has_token)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button onClick={test} disabled={busy === 'test' || !st.has_token}
              className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors disabled:opacity-50">
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            {form.open && (
              <button onClick={() => setForm(f => ({ ...f, open: false, access_token: '' }))}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors">Cancel</button>
            )}
          </div>
        </div>
      )}

      {!st.loading && st.configured && !form.open && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          <button onClick={test} disabled={busy === 'test'}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors disabled:opacity-50">
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button onClick={() => setForm(f => ({ ...f, open: true, access_token: '' }))}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors">
            Update token / location
          </button>
        </div>
      )}
    </div>
  )
}
