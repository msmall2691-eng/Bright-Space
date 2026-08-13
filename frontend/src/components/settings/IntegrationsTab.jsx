import { useEffect, useState } from 'react'
import GoogleAccountCard from '../GoogleAccountCard'
import { get, post } from '../../api'

/** Integrations tab — the "connect BrightBase to Google / your phone /
 *  external tools" hub, reorganized into two sections:
 *    - Google        — GoogleAccountCard (per-user grant) + business GCal
 *                      status with the embed URL inline + Gmail per-account health.
 *    - Other         — Square Payroll, plus "Coming soon" chips for
 *                      Stripe / Zapier.
 *
 *  Customer-messaging toggle and iCal Turnover Sync used to live here too but
 *  they're automation switches, not integrations — moved to AutomationTab. */
export default function IntegrationsTab({ toast, active }) {
  const [gcalEmbed, setGcalEmbed] = useState('')
  const [gcalEmbedSaving, setGcalEmbedSaving] = useState(false)
  const [gcalConn, setGcalConn] = useState({ loading: true })
  const [gcalConnecting, setGcalConnecting] = useState(false)
  const [gmailConn, setGmailConn] = useState({ loading: true })

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

  useEffect(() => {
    if (!active) return
    get('/api/settings/gcal-embed').then(r => setGcalEmbed(r?.override || '')).catch(() => {})
    refreshGcalStatus()
    refreshGmailStatus()
  }, [active])

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

        {/* Other integrations — payments + external workflows. */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">Other integrations</h2>
            <p className="text-sm text-ink-2 mt-1">Take payments and hook into external workflows.</p>
          </div>

          <div className="space-y-3">
            <SquareCard toast={toast} active={active} />

            {/* Stripe / Zapier — not built yet. The "Connect" button here
                used to be an orphaned <button> with no onClick — clicking it
                did literally nothing, which set operators up to click and
                click waiting for a modal that would never appear. Downgraded
                to a "Coming soon" chip so the roadmap is visible without
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
