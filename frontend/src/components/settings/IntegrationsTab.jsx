import { useEffect, useState } from 'react'
import GoogleAccountCard from '../GoogleAccountCard'
import { get, post } from '../../api'

/** Integrations tab — the "connect BrightBase to Google / your phone /
 *  external tools" hub, reorganized into two sections:
 *    - Google        — GoogleAccountCard (per-user grant) + business GCal
 *                      status with the embed URL inline + Gmail per-account health.
 *    - Other         — Stripe status (online payment + subcontractor direct
 *                      deposit), plus a "Coming soon" chip for Zapier.
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
                <span className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    gcalConn.loading ? 'bg-ink-3' : gcalConn.connected ? 'bg-emerald-500' : 'bg-red-500'
                  }`} aria-hidden="true" />
                  {gcalConn.loading ? 'Checking…' : gcalConn.connected ? 'Connected' : 'Not connected'}
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
              <div className="mt-3 text-xs bg-panel border border-hairline rounded-lg p-3 leading-relaxed">
                <div className="flex items-center gap-1.5 font-semibold text-ink mb-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" />
                  Appointments aren't reaching Google.
                </div>
                <span className="text-ink-2">{gcalConn.detail || 'Google Calendar credentials are missing or invalid on the server.'}</span>
                {!gcalConn.oauth_available && (
                  <div className="mt-1 text-[11px] text-ink-3">
                    To enable one-click connect, add a Google "Web" OAuth client on the server
                    (GOOGLE_CREDENTIALS_B64) with redirect URI <code className="bg-bg-2 px-1 rounded">/api/settings/google/callback</code>.
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
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-xs text-ink placeholder-ink-3 font-mono focus:outline-hidden focus:border-blue-400 resize-none"
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
              <span className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 shrink-0">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  gmailConn.loading ? 'bg-ink-3' : gmailConn.connected ? 'bg-emerald-500' : 'bg-red-500'
                }`} aria-hidden="true" />
                {gmailConn.loading ? 'Checking…' : gmailConn.connected ? 'Connected' : 'Not connected'}
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

        {/* Text messages — Twilio status, who gets lead/booking alerts, and a
            recent-activity read so an operator can see why a text did or didn't
            go out (the owner alert phone was previously env-only, unsettable in
            the app, and owner-alert texts weren't on the audit log at all). */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">Text messages (SMS)</h2>
            <p className="text-sm text-ink-2 mt-1">Who gets alerted when a lead or booking comes in, and whether texts are going out.</p>
          </div>
          <SmsCard toast={toast} active={active} />
        </div>

        {/* Other integrations — payments + external workflows. */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink">Other integrations</h2>
            <p className="text-sm text-ink-2 mt-1">Take payments and hook into external workflows.</p>
          </div>

          <div className="space-y-3">
            <StripeCard active={active} />

            {/* Zapier — not built. Stripe used to sit in this list as a
                "Coming soon" chip; it is built now, so it graduated to the
                real status card above. The chip stays a chip (and not a
                "Connect" button) because the button here was once an orphaned
                <button> with no onClick — operators clicked and clicked
                waiting for a modal that would never appear. */}
            {[
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

// Text messages — Twilio status, owner-alert destinations (phone + email that
// get pinged on a new lead/booking), and a recent-activity read. The owner
// alert phone in particular was previously only settable as a Railway env var;
// here it saves to an AppSetting the backend prefers over the env var.
function SmsCard({ toast, active }) {
  const [st, setSt] = useState({ loading: true })
  const [form, setForm] = useState({ phone: '', email: '' })
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const refresh = () => {
    setSt(s => ({ ...s, loading: true }))
    return get('/api/settings/sms-status')
      .then(r => {
        setSt({ loading: false, ...r })
        setForm({ phone: r.owner_alert_phone?.value || '', email: r.owner_alert_email?.value || '' })
      })
      .catch(e => setSt({ loading: false, error: e?.message || 'Could not check status' }))
  }
  const refreshEvents = () => get('/api/integration-events?provider=sms&limit=15')
    .then(setEvents).catch(() => setEvents([]))

  useEffect(() => { if (active) { refresh(); refreshEvents() } }, [active])

  const save = async () => {
    setBusy(true)
    try {
      const r = await post('/api/settings/notifications', {
        owner_alert_phone: form.phone.trim(),
        owner_alert_email: form.email.trim(),
      })
      setSt({ loading: false, ...r })
      setForm({ phone: r.owner_alert_phone?.value || '', email: r.owner_alert_email?.value || '' })
      toast('Alert destinations saved')
    } catch (e) {
      toast(e?.detail || e?.message || 'Could not save', 'error')
    } finally { setBusy(false) }
  }

  const sendTest = async () => {
    setTesting(true); setTestResult(null)
    try {
      const r = await post('/api/settings/sms-test', { to: form.phone.trim() })
      setTestResult(r)
      if (r.ok) toast('Test text sent')
      refreshEvents()   // the attempt lands in the activity log
    } catch (e) {
      setTestResult({ ok: false, error: e?.detail || e?.message || 'Could not send test' })
    } finally { setTesting(false) }
  }

  const twilioOk = !st.loading && st.twilio_configured
  const srcLabel = { database: 'saved here', env: 'from server config', none: 'not set' }
  const ACTIONS = {
    owner_alert: 'Owner alert', booking_confirm: 'Booking confirmation',
    reminder: 'Reminder', invoice: 'Invoice', notice: 'Notice',
    client_text: 'Text to client', comms: 'Message', comms_forward: 'Forward',
    offer: 'Job offer', crew: 'Crew alert', test: 'Test text',
  }
  const fmt = (iso) => { try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return '' } }
  // Turn a raw Twilio error into a plain-English cause + next step. Matches on
  // the error code that Twilio embeds in the message (e.g. "...error 30034...").
  const errorHint = (msg) => {
    const m = /\b(2\d{4}|3\d{4}|6\d{4})\b/.exec(msg || '')
    const code = m && m[1]
    const HINTS = {
      '30034': "This number isn't registered for A2P 10DLC — US carriers block texts from unregistered numbers. Finish the Sole-Proprietor brand + campaign in Twilio, then attach this number.",
      '30007': 'Carrier filtered this as spam — almost always A2P 10DLC registration not being complete.',
      '30003': 'The handset was unreachable (off, or no longer in service).',
      '30005': 'Unknown or unreachable number.',
      '30006': 'That number is a landline or unreachable carrier — it can’t receive texts.',
      '21610': 'This person replied STOP and is unsubscribed. They must text START to opt back in.',
      '21614': "That number can't receive SMS.",
      '21408': "Your Twilio account isn't permitted to text this region yet.",
    }
    if (code && HINTS[code]) return HINTS[code]
    if (/not configured|credentials/i.test(msg || '')) return 'Twilio isn’t configured on the server.'
    return null
  }

  return (
    <div className="bg-panel rounded-xl border border-hairline p-4 space-y-4">
      {/* Twilio connection status */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="text-2xl">💬</span>
          <div>
            <h3 className="font-semibold text-ink">Twilio</h3>
            <p className="text-xs text-ink-3">The number every BrightBase text is sent from</p>
          </div>
        </div>
        <span className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 shrink-0">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.loading ? 'bg-ink-3' : twilioOk ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden="true" />
          {st.loading ? 'Checking…' : twilioOk ? 'Configured' : 'Not configured'}
        </span>
      </div>
      {!st.loading && !twilioOk && (
        <div className="text-xs bg-panel border border-hairline rounded-lg p-3 leading-relaxed text-ink-2">
          Twilio credentials aren't set on the server, so no texts can be sent. Set <code className="bg-bg-2 px-1 rounded">TWILIO_ACCOUNT_SID</code>, <code className="bg-bg-2 px-1 rounded">TWILIO_AUTH_TOKEN</code> and <code className="bg-bg-2 px-1 rounded">TWILIO_PHONE_NUMBER</code> on the BrightBase service.
        </div>
      )}

      {/* Owner-alert destinations */}
      <div className="border-t border-hairline pt-4">
        <div className="text-xs font-semibold text-ink-2 mb-1">Where new-lead & booking alerts go</div>
        <p className="text-[11px] text-ink-3 mb-3">The office gets a text and an email whenever a request comes in. Leave a field blank to turn that channel off (or fall back to the server's configured value).</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="flex items-center justify-between text-[11px] font-medium text-ink-2 mb-1">
              <span>Alert phone (text)</span>
              {!st.loading && <span className="text-[10px] text-ink-3">{srcLabel[st.owner_alert_phone?.source] || ''}</span>}
            </label>
            <input type="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              placeholder="(207) 555-0142"
              className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400" />
          </div>
          <div>
            <label className="flex items-center justify-between text-[11px] font-medium text-ink-2 mb-1">
              <span>Alert email</span>
              {!st.loading && <span className="text-[10px] text-ink-3">{srcLabel[st.owner_alert_email?.source] || ''}</span>}
            </label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="office@example.com"
              className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={save} disabled={busy || st.loading}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50">
            {busy ? 'Saving…' : 'Save alert destinations'}
          </button>
          <button onClick={sendTest} disabled={testing || st.loading}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors disabled:opacity-50">
            {testing ? 'Sending…' : 'Send test text'}
          </button>
        </div>
        {testResult && (
          <div className="mt-2 flex items-start gap-1.5 text-[12px]">
            <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${testResult.ok ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden="true" />
            <span className={testResult.ok ? 'text-ink-2' : 'text-ink'}>
              {testResult.ok
                ? `Test text sent to ${testResult.to}${testResult.status ? ` (${testResult.status})` : ''} — check that phone.`
                : <>Couldn't send{testResult.to ? ` to ${testResult.to}` : ''}: <span className="text-red-600 break-words">{testResult.error}</span></>}
            </span>
          </div>
        )}
      </div>

      {/* Recent SMS activity — the audit read, so "did a text go out?" is
          answerable without server logs. */}
      <div className="border-t border-hairline pt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-ink-2">Recent text activity</div>
          <button onClick={refreshEvents} className="text-[11px] text-ink-3 hover:text-ink-2">Refresh</button>
        </div>
        {events === null && <p className="text-[11px] text-ink-3">Loading…</p>}
        {events !== null && events.length === 0 && (
          <p className="text-[11px] text-ink-3">No text messages recorded yet.</p>
        )}
        {events !== null && events.length > 0 && (
          <div className="space-y-1.5">
            {events.map(e => (
              <div key={e.id} className="flex items-start gap-2 text-[11.5px]">
                <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${e.status === 'ok' ? 'bg-emerald-500' : e.status === 'failed' ? 'bg-red-500' : 'bg-ink-3'}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-ink-2 font-medium">{ACTIONS[e.action] || e.action}</span>
                    <span className="text-ink-3">{(e.request_payload || '').replace(/^to /, '') || ''}</span>
                    <span className="text-ink-3 ml-auto shrink-0">{fmt(e.created_at)}</span>
                  </div>
                  {e.status === 'failed' && e.error_message && (
                    <div className="mt-0.5">
                      <div className="text-red-600 break-words">{e.error_message}</div>
                      {errorHint(e.error_message) && (
                        <div className="text-ink-2 mt-0.5">{errorHint(e.error_message)}</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Stripe — read-only status. Deliberately has no form: Stripe is configured by
// environment variable (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET) on the
// server, so there is nothing to type here and the key never passes through the
// browser the way the old Square access token did.
//
// This replaced SquareCard. That card collected a Square access token for the
// Labor API timecard export, which was deleted in Sept 2026 — a timecard
// asserts an hourly wage and an employment relationship, which is the one thing
// a subcontractor arrangement cannot say. The card outlived the feature, so it
// was a connect form for something that could no longer do anything.
function StripeCard({ active }) {
  const [st, setSt] = useState({ loading: true })

  useEffect(() => {
    if (!active) return
    setSt({ loading: true })
    get('/api/settings/stripe-status')
      .then(r => setSt({ loading: false, ...r }))
      .catch(e => setSt({ loading: false, configured: false, detail: e?.message || 'Could not check status' }))
  }, [active])

  // Three states, not two: connected-but-no-webhook is the one that silently
  // takes money and never marks the invoice paid, so it reads as needs-
  // attention (amber) rather than connected.
  const tone = st.loading ? 'bg-ink-3'
    : !st.configured ? 'bg-ink-3'
    : !st.webhook_configured ? 'bg-amber-500'
    : 'bg-emerald-500'
  const word = st.loading ? 'Checking…'
    : !st.configured ? 'Not connected'
    : !st.webhook_configured ? 'Needs webhook'
    : 'Connected'

  return (
    <div className="bg-panel rounded-xl border border-hairline p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="text-2xl">💳</span>
          <div>
            <h3 className="font-semibold text-ink">Stripe</h3>
            <p className="text-xs text-ink-3">Online invoice payment and subcontractor direct deposit</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} aria-hidden="true" />
          <span className="text-xs text-ink-2">{word}</span>
        </div>
      </div>
      {st.detail && (
        <p className="text-xs text-ink-3 mt-3 pt-3 border-t border-hairline">{st.detail}</p>
      )}
    </div>
  )
}
