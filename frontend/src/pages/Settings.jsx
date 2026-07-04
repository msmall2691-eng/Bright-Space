import { useState, useEffect, useCallback } from 'react'
import { X, Settings2, Mail, Loader2, Plug, RefreshCw, Users } from 'lucide-react'
import UsersAdmin from '../components/UsersAdmin'
import GoogleAccountCard from '../components/GoogleAccountCard'
import { get, post } from "../api"
import Toast from '../components/settings/Toast'
import { useCustomFieldsTab, CustomFieldsBody, CustomFieldsSidePanel } from '../components/settings/CustomFieldsTab'
import AutomationTab, { useAutomationSettings } from '../components/settings/AutomationTab'
import EmailTab from '../components/settings/EmailTab'
import DangerZone from '../components/settings/DangerZone'
import GeneralTab from '../components/settings/GeneralTab'

export default function Settings() {
  const [section, setSection] = useState('fields') // 'fields' | 'email' | 'general' | 'integrations' | 'users'
  // Users management is admin-only (the backend enforces it; this hides the tab).
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
    catch { return false }
  })()
  const [toasts, setToasts] = useState([])

  // Stop iCal sync (Integrations tab) — flips iCal auto-sync off + deactivates feeds
  const [stoppingIcal, setStoppingIcal] = useState(false)

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

  // Automation settings

  // Google Calendar embed override (paste an embed URL or full <iframe>).
  const [gcalEmbed, setGcalEmbed] = useState('')
  const [gcalEmbedSaving, setGcalEmbedSaving] = useState(false)
  // Live Google Calendar connection status (real check, not a hardcoded badge).
  const [gcalConn, setGcalConn] = useState({ loading: true })
  const [gcalConnecting, setGcalConnecting] = useState(false)
  const refreshGcalStatus = () => {
    setGcalConn({ loading: true })
    return get('/api/settings/gcal-status')
      .then(r => setGcalConn({ loading: false, ...r }))
      .catch(e => setGcalConn({ loading: false, connected: false, reason: 'error', detail: e?.message || 'Could not check status' }))
  }
  // Live Gmail connection health (mirrors gcal-status) so an expired grant that
  // silently stops inbound email sync surfaces a reconnect signal.
  const [gmailConn, setGmailConn] = useState({ loading: true })
  const refreshGmailStatus = () => {
    setGmailConn({ loading: true })
    return get('/api/settings/gmail-status')
      .then(r => setGmailConn({ loading: false, ...r }))
      .catch(e => setGmailConn({ loading: false, connected: false, accounts: [], detail: e?.message || 'Could not check status' }))
  }
  // Live "are we auto-messaging customers?" state (read-only indicator).
  const [msgStatus, setMsgStatus] = useState({ loading: true })
  const [msgSaving, setMsgSaving] = useState(false)
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
  useEffect(() => {
    if (section !== 'integrations') return
    get('/api/settings/gcal-embed').then(r => setGcalEmbed(r?.override || '')).catch(() => {})
    refreshGcalStatus()
    refreshGmailStatus()
    get('/api/settings/messaging-status')
      .then(r => setMsgStatus({ loading: false, ...r }))
      .catch(() => setMsgStatus({ loading: false, error: true }))
  }, [section])
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

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }, [])

  const customFields = useCustomFieldsTab({ toast })
  const automation = useAutomationSettings({
    toast,
    active: section === 'integrations' || section === 'automation' || section === 'general',
  })
  const { automationSettings, setAutomationSettings } = automation

  return (
    <div className="flex h-full">

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Header */}
        <div className="px-4 sm:px-8 py-6 border-b border-hairline bg-panel">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold text-ink">Settings</h1>
              <p className="text-sm text-ink-3 mt-1">Manage your account and integrations</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSection('general')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'general' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Settings2 className="w-3.5 h-3.5" /> General
            </button>
            <button onClick={() => setSection('integrations')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'integrations' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Plug className="w-3.5 h-3.5" /> Integrations
            </button>
            <button onClick={() => setSection('automation')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'automation' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <RefreshCw className="w-3.5 h-3.5" /> Automation
            </button>
            <button onClick={() => setSection('email')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'email' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Mail className="w-3.5 h-3.5" /> Email
            </button>
            <button onClick={() => setSection('fields')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'fields' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Settings2 className="w-3.5 h-3.5" /> Custom Fields
            </button>
            {isAdmin && (
              <button onClick={() => setSection('users')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'users' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                <Users className="w-3.5 h-3.5" /> Users
              </button>
            )}
          </div>
        </div>

        {/* === USERS SECTION (admin only) === */}
        {section === 'users' && isAdmin && (
          <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
            <div className="max-w-2xl pt-6">
              <UsersAdmin />
            </div>
          </div>
        )}

        {/* === GENERAL SETTINGS SECTION === */}
        {section === 'general' && (
          <GeneralTab
            toast={toast}
            active={section === 'general'}
            dangerZone={<DangerZone toast={toast} automationSettings={automationSettings} setAutomationSettings={setAutomationSettings} />}
          />
        )}

        {/* === INTEGRATIONS SECTION === */}
        {section === 'integrations' && (
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

              {/* Google Calendar embed — powers the in-app "Google" view + each
                  client's Calendar tab. Paste the embed URL or full <iframe>
                  from Google Calendar → Settings → "Integrate calendar". */}
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

              {/* iCal Turnover Sync — real, controllable integration */}
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

                {/* The "Delete scheduled visits" card was removed alongside
                    its backend endpoint (POST /api/admin/delete-scheduled-visits)
                    when the Visit table was retired in the Job/Visit unification.
                    Occurrences are Jobs now; cancelling a job's schedule is done
                    via the schedule/agenda cancel flows. */}
              </div>

              {/* Other connected services */}
              <div>
                <div className="mb-4">
                  <h2 className="text-lg font-bold text-ink">Connected Services</h2>
                  <p className="text-sm text-ink-2 mt-1">Connect external tools to enhance your workflow</p>
                </div>

                {/* Google Calendar — real, live connection status. The app
                    writes every appointment to this account's calendar, so if
                    it isn't truly connected, events silently never appear. */}
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

                {/* Gmail — live per-account connection health. An expired grant
                    silently stops inbound email sync, so surface a reconnect signal. */}
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
                  {[
                    { name: 'Connecteam', icon: '👥', desc: 'Dispatch jobs to your field team', status: 'available' },
                    { name: 'Stripe', icon: '💳', desc: 'Accept online payments', status: 'available' },
                    { name: 'Zapier', icon: '⚡', desc: 'Automate workflows with 5000+ apps', status: 'available' },
                  ].map((integration, idx) => (
                    <div key={idx} className="bg-panel rounded-xl border border-hairline p-4 flex items-center justify-between hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-4">
                        <span className="text-2xl">{integration.icon}</span>
                        <div>
                          <h3 className="font-semibold text-ink">{integration.name}</h3>
                          <p className="text-xs text-ink-3">{integration.desc}</p>
                        </div>
                      </div>
                      <button className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        integration.status === 'connected'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                      }`}>
                        {integration.status === 'connected' ? '✓ Connected' : 'Connect'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* === AUTOMATION SECTION === */}
        {section === 'automation' && <AutomationTab state={automation} />}

        {/* === EMAIL SETTINGS SECTION === */}
        {section === 'email' && <EmailTab toast={toast} active={section === 'email'} />}

        {/* === CUSTOM FIELDS SECTION === */}
        {section === 'fields' && <CustomFieldsBody state={customFields} />}
      </div>

      {/* Side panel */}
      {section === 'fields' && <CustomFieldsSidePanel state={customFields} />}

      <Toast toasts={toasts} />

    </div>
  )
}
