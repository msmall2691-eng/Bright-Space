import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, X, GripVertical, Settings2, Mail, CheckCircle, AlertTriangle, Loader2, Shield, Plug, RefreshCw, Zap, Users } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import UsersAdmin from '../components/UsersAdmin'
import GoogleAccountCard from '../components/GoogleAccountCard'
import { del, get, post, patch } from "../api"
import { applyTheme, getTheme } from '../theme'


const ENTITY_TABS = [
  { key: 'client',   label: 'Clients',    desc: 'Fields shown on every client record' },
  { key: 'property', label: 'Properties', desc: 'Fields shown on every property record' },
  { key: 'job',      label: 'Jobs',       desc: 'Fields shown on every job / appointment' },
  { key: 'invoice',  label: 'Invoices',   desc: 'Fields shown on every invoice' },
]

const FIELD_TYPES = [
  { value: 'text',     label: 'Text' },
  { value: 'number',   label: 'Number' },
  { value: 'date',     label: 'Date' },
  { value: 'select',   label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'textarea', label: 'Long text' },
]

const TYPE_BADGE = {
  text:     'bg-bg-2 text-ink-3',
  number:   'bg-blue-50 text-blue-700',
  date:     'bg-violet-50 text-violet-700',
  select:   'bg-amber-50 text-amber-700',
  checkbox: 'bg-emerald-50 text-emerald-700',
  textarea: 'bg-bg-2 text-ink-3',
}

const EMPTY_FORM = { name: '', field_type: 'text', options: '', required: false, sort_order: 0 }

const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1.5'
const inp = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 transition-colors'

function Toast({ toasts }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-lg border pointer-events-auto
            ${t.type === 'success' ? 'bg-panel border-hairline text-ink' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${t.type === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {t.message}
        </div>
      ))}
    </div>
  )
}

export default function Settings() {
  const [section, setSection] = useState('fields') // 'fields' | 'email' | 'general' | 'integrations' | 'users'
  // Users management is admin-only (the backend enforces it; this hides the tab).
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
    catch { return false }
  })()
  const [themeChoice, setThemeChoice] = useState(getTheme())
  const [showScout, setShowScout] = useState(() => localStorage.getItem('brightbase_hide_scout') !== '1')
  const [entityTab, setEntityTab] = useState('client')
  const [fields, setFields] = useState([])
  const [panel, setPanel] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [toasts, setToasts] = useState([])

  // General settings
  const [generalSettings, setGeneralSettings] = useState({
    company_name: 'Maine Cleaning Co.',
    company_email: '',
    company_phone: '',
    timezone: 'America/New_York',
    currency: 'USD',
    quote_terms: '',
  })
  const [generalSaving, setGeneralSaving] = useState(false)

  // Danger zone — reset all data
  const [resetConfirmText, setResetConfirmText] = useState('')
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState(null)

  // Danger zone — unlink calendars
  const [unlinkConfirmText, setUnlinkConfirmText] = useState('')
  const [unlinking, setUnlinking] = useState(false)
  const [unlinkResult, setUnlinkResult] = useState(null)
  const [unlinkClearGcal, setUnlinkClearGcal] = useState(true)
  const [unlinkDeactivateIcal, setUnlinkDeactivateIcal] = useState(true)

  // Quick "pause all syncs" — flips both auto-sync flags off
  const [pausing, setPausing] = useState(false)

  // Stop iCal sync (Integrations tab) — flips iCal auto-sync off + deactivates feeds
  const [stoppingIcal, setStoppingIcal] = useState(false)

  // Delete all scheduled visits (Integrations tab)
  const [deleteVisitsConfirm, setDeleteVisitsConfirm] = useState('')
  const [deleteVisitsOnlyIcal, setDeleteVisitsOnlyIcal] = useState(true)
  const [deleteVisitsIncludeDispatched, setDeleteVisitsIncludeDispatched] = useState(false)
  const [deletingVisits, setDeletingVisits] = useState(false)
  const [deleteVisitsResult, setDeleteVisitsResult] = useState(null)
  const runResetData = async () => {
    if (resetConfirmText !== 'RESET') return
    if (!confirm('This will permanently delete ALL clients, properties, jobs, visits, quotes, invoices, conversations, messages, leads, opportunities, and activities. Users and settings are preserved. Continue?')) return
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

  const runUnlinkCalendars = async () => {
    if (unlinkConfirmText !== 'UNLINK') return
    if (!unlinkClearGcal && !unlinkDeactivateIcal) {
      toast('Select at least one option', 'error')
      return
    }
    if (!confirm('This will detach BrightBase from Google Calendar and disable iCal feeds. Local jobs/visits/properties remain. Continue?')) return
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

  const deleteScheduledVisits = async () => {
    if (deleteVisitsConfirm !== 'DELETE') return
    const scope = deleteVisitsOnlyIcal ? 'iCal-sourced' : 'all'
    const lifecycle = deleteVisitsIncludeDispatched ? 'scheduled, dispatched, en-route, and in-progress' : 'scheduled'
    if (!confirm(`This will permanently delete ${scope} visits in status: ${lifecycle}. Completed and cancelled visits are preserved. Continue?`)) return
    setDeletingVisits(true)
    setDeleteVisitsResult(null)
    try {
      const data = await post('/api/admin/delete-scheduled-visits', {
        confirm: 'DELETE',
        only_ical: deleteVisitsOnlyIcal,
        include_dispatched: deleteVisitsIncludeDispatched,
      })
      setDeleteVisitsResult(data)
      setDeleteVisitsConfirm('')
      toast(`Deleted ${data.deleted} scheduled visits`)
    } catch (e) {
      setDeleteVisitsResult({ error: e?.message || 'Delete failed' })
      toast('Delete failed: ' + (e?.message || 'unknown'), 'error')
    } finally {
      setDeletingVisits(false)
    }
  }

  // Automation settings
  const [automationSettings, setAutomationSettings] = useState({
    ical_auto_sync_enabled: true,
    ical_sync_interval: 15,
    gcal_auto_sync_enabled: true,
    gcal_sync_interval: 10,
    recurring_auto_generate_enabled: true,
    invite_customers: true,
  })
  const [automationSaving, setAutomationSaving] = useState(false)

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

  // Email settings state
  const [emailConfig, setEmailConfig] = useState({
    smtp_user: '', smtp_pass: '', smtp_host: 'smtp.gmail.com', smtp_port: '587',
    imap_host: 'imap.gmail.com', imap_port: '993', from_email: '', from_name: '',
    email_auto_enrich: 'true',
  })
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailSaving, setEmailSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [hasCredentials, setHasCredentials] = useState(false)

  const loadEmailSettings = useCallback(async () => {
    setEmailLoading(true)
    try {
      const data = await get('/api/settings/email')
      setHasCredentials(data.has_credentials || false)
      setEmailConfig(prev => ({
        ...prev,
        smtp_user: data.smtp_user || '',
        smtp_pass: data.smtp_pass || '',
        smtp_host: data.smtp_host || 'smtp.gmail.com',
        smtp_port: data.smtp_port || '587',
        imap_host: data.imap_host || 'imap.gmail.com',
        imap_port: data.imap_port || '993',
        from_email: data.from_email || '',
        from_name: data.from_name || '',
        email_auto_enrich: data.email_auto_enrich || 'true',
        credentials_source: data.credentials_source || 'none',
      }))
    } catch {}
    setEmailLoading(false)
  }, [])

  useEffect(() => { if (section === 'email') loadEmailSettings() }, [section, loadEmailSettings])

  const loadAutomationSettings = useCallback(async () => {
    try {
      const data = await get('/api/settings/automation')
      setAutomationSettings(s => ({ ...s, ...data }))
    } catch (err) {
      console.error('[Settings] failed to load automation settings', err)
    }
  }, [])

  useEffect(() => {
    if (section === 'integrations' || section === 'automation' || section === 'general') {
      loadAutomationSettings()
    }
    if (section === 'general') {
      get('/api/settings/general')
        .then(d => setGeneralSettings(s => {
          const next = { ...s }
          for (const k of Object.keys(next)) if (d?.[k] != null) next[k] = d[k]
          return next
        }))
        .catch(() => {})
    }
  }, [section, loadAutomationSettings])

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }, [])

  const load = useCallback(() =>
    get(`/api/fields?entity_type=${entityTab}`).then(setFields).catch(err => console.error("[Settings]", err)),
    [entityTab]
  )

  useEffect(() => { load() }, [load])

  const openNew = () => {
    setForm({ ...EMPTY_FORM })
    setPanel('new')
  }

  const openEdit = (field) => {
    setForm({
      name: field.name,
      field_type: field.field_type,
      options: (field.options || []).join('\n'),
      required: field.required,
      sort_order: field.sort_order,
    })
    setPanel(field.id)
  }

  const closePanel = () => setPanel(null)

  const save = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const payload = {
        entity_type: entityTab,
        name: form.name.trim(),
        field_type: form.field_type,
        options: form.field_type === 'select'
          ? form.options.split('\n').map(s => s.trim()).filter(Boolean)
          : [],
        required: form.required,
        sort_order: parseInt(form.sort_order) || 0,
      }
      const isNew = panel === 'new'
      const url = isNew ? '/api/fields' : `/api/fields/${panel}`
      isNew ? await post(url, payload) : await patch(url, payload)
      await load()
      toast(isNew ? 'Field created' : 'Field updated')
      closePanel()
    } catch {
      toast('Failed to save field', 'error')
    }
    setSaving(false)
  }

  const deleteField = async (id) => {
    try {
      await del(`/api/fields/${id}`)
      await load()
      if (panel === id) closePanel()
      toast('Field deleted')
    } catch {
      toast('Failed to delete field', 'error')
    }
  }

  const saveEmailConfig = async () => {
    setEmailSaving(true)
    try {
      await post('/api/settings/email', emailConfig)
      toast('Email settings saved')
      loadEmailSettings()
    } catch { toast('Failed to save', 'error') }
    setEmailSaving(false)
  }

  const testEmailConnection = async () => {
    setTesting(true); setTestResult(null)
    try {
      const res = await post('/api/settings/email/test')
      setTestResult(res)
    } catch (e) {
      setTestResult({ error: e.message || 'Test failed' })
    }
    setTesting(false)
  }

  const saveGeneralSettings = async () => {
    setGeneralSaving(true)
    try {
      await post('/api/settings/general', generalSettings)
      toast('General settings saved')
    } catch (err) {
      toast('Failed to save general settings', 'error')
    }
    setGeneralSaving(false)
  }

  const saveAutomationSettings = async () => {
    setAutomationSaving(true)
    try {
      await post('/api/settings/automation', automationSettings)
      toast('Automation settings saved')
    } catch (err) {
      toast('Failed to save automation settings', 'error')
    }
    setAutomationSaving(false)
  }

  const currentEntity = ENTITY_TABS.find(t => t.key === entityTab)

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
          <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
            <div className="max-w-2xl pt-6 space-y-6">
              <div>
                <h2 className="text-lg font-bold text-ink mb-4">Appearance</h2>
                <div className="bg-panel rounded-xl border border-hairline p-6">
                  <label className={lbl}>Theme</label>
                  <div className="flex gap-2 mt-1">
                    {[
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ].map(opt => (
                      <button key={opt.value} type="button"
                        onClick={() => setThemeChoice(applyTheme(opt.value))}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                          themeChoice === opt.value
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-bg-2 text-ink-2 border-hairline hover:border-hairline-2'
                        }`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-ink-3 mt-2">Applies instantly and is remembered on this device.</p>

                  <div className="border-t border-hairline mt-5 pt-5">
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <span>
                        <span className={lbl}>AI assistant</span>
                        <span className="block text-xs text-ink-3 mt-0.5">Show the floating "Ask Scout" button on every page.</span>
                      </span>
                      <input type="checkbox" checked={showScout}
                        onChange={e => {
                          const show = e.target.checked
                          setShowScout(show)
                          if (show) localStorage.removeItem('brightbase_hide_scout')
                          else localStorage.setItem('brightbase_hide_scout', '1')
                          window.dispatchEvent(new Event('scout-visibility'))
                        }}
                        className="w-4 h-4 shrink-0 cursor-pointer" />
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <h2 className="text-lg font-bold text-ink mb-4">Company Information</h2>
                <div className="bg-panel rounded-xl border border-hairline p-6">
                  <div>
                    <label className={lbl}>Company Name</label>
                    <input type="text" value={generalSettings.company_name}
                      onChange={e => setGeneralSettings(s => ({ ...s, company_name: e.target.value }))}
                      placeholder="Maine Cleaning Co."
                      className={inp} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className={lbl}>Company Email</label>
                      <input type="email" value={generalSettings.company_email}
                        onChange={e => setGeneralSettings(s => ({ ...s, company_email: e.target.value }))}
                        placeholder="office@mainecleaningco.com"
                        className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Company Phone</label>
                      <input type="tel" value={generalSettings.company_phone}
                        onChange={e => setGeneralSettings(s => ({ ...s, company_phone: e.target.value }))}
                        placeholder="+1 (207) 555-0100"
                        className={inp} />
                    </div>
                  </div>
                  <p className="text-[11px] text-ink-3 mt-2">Shown on the public quote page ("Questions?") and used across customer-facing email.</p>
                  <div className="mt-4">
                    <label className={lbl}>Quote Terms &amp; Conditions (optional)</label>
                    <textarea rows={4} value={generalSettings.quote_terms}
                      onChange={e => setGeneralSettings(s => ({ ...s, quote_terms: e.target.value }))}
                      placeholder="Payment due upon completion. Cancellations require 24h notice. …"
                      className={inp + ' resize-none'} />
                    <p className="text-[11px] text-ink-3 mt-1">Appears at the bottom of every public quote page. Leave blank to hide.</p>
                  </div>
                </div>
              </div>

              <div>
                <h2 className="text-lg font-bold text-ink mb-4">Regional Settings</h2>
                <div className="bg-panel rounded-xl border border-hairline p-6 space-y-4">
                  <div>
                    <label className={lbl}>Timezone</label>
                    <select value={generalSettings.timezone}
                      onChange={e => setGeneralSettings(s => ({ ...s, timezone: e.target.value }))}
                      className={inp}>
                      <option value="America/New_York">Eastern Time (ET)</option>
                      <option value="America/Chicago">Central Time (CT)</option>
                      <option value="America/Denver">Mountain Time (MT)</option>
                      <option value="America/Los_Angeles">Pacific Time (PT)</option>
                      <option value="UTC">UTC</option>
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Currency</label>
                    <select value={generalSettings.currency}
                      onChange={e => setGeneralSettings(s => ({ ...s, currency: e.target.value }))}
                      className={inp}>
                      <option value="USD">USD ($)</option>
                      <option value="EUR">EUR (€)</option>
                      <option value="GBP">GBP (£)</option>
                      <option value="CAD">CAD (C$)</option>
                    </select>
                  </div>
                </div>
              </div>

              <button onClick={saveGeneralSettings} disabled={generalSaving}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {generalSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Save Changes
              </button>

              {/* Danger zone — sync controls + reset */}
              <div className="pt-8" data-testid="danger-zone">
                <h2 className="text-lg font-bold text-red-600 mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" /> Danger Zone
                </h2>

                {/* Pause all syncs (reversible) */}
                <div className="bg-panel rounded-xl border border-amber-200 p-6 space-y-4 mb-4">
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
                <div className="bg-panel rounded-xl border border-orange-200 p-6 space-y-4 mb-4">
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
                    <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg p-3 text-xs">
                      <div className="font-semibold mb-1">✓ Unlinked</div>
                      <ul className="list-disc list-inside space-y-0.5">
                        <li>Jobs cleared: {unlinkResult.jobs_unlinked}</li>
                        <li>Visits cleared: {unlinkResult.visits_unlinked}</li>
                        <li>iCal feeds deactivated: {unlinkResult.ical_feeds_deactivated}</li>
                        <li>Property iCal URLs cleared: {unlinkResult.properties_ical_url_cleared}</li>
                      </ul>
                    </div>
                  )}
                  {unlinkResult?.error && (
                    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-xs">
                      Unlink failed: {unlinkResult.error}
                    </div>
                  )}
                </div>

                <div className="bg-panel rounded-xl border border-red-200 p-6 space-y-4">
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
                    <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg p-3 text-xs">
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
                    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-xs">
                      Reset failed: {resetResult.error}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
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

                {/* Maintenance — delete all scheduled visits */}
                <div className="mt-4 bg-panel rounded-xl border border-red-200 p-5 space-y-4" data-testid="delete-visits-card">
                  <div>
                    <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                      <Trash2 className="w-4 h-4 text-red-600" /> Delete scheduled visits
                    </h3>
                    <p className="text-xs text-ink-3 mt-1">
                      Clear out future visits that haven't been completed yet. Useful right after
                      stopping iCal sync to wipe auto-generated turnover visits. Completed,
                      no-show, and cancelled visits are always preserved.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs text-ink-2">
                      <input
                        type="checkbox"
                        checked={deleteVisitsOnlyIcal}
                        onChange={e => setDeleteVisitsOnlyIcal(e.target.checked)}
                        className="w-4 h-4 rounded border-hairline"
                        data-testid="delete-visits-only-ical"
                      />
                      Only delete visits sourced from iCal feeds
                    </label>
                    <label className="flex items-center gap-2 text-xs text-ink-2">
                      <input
                        type="checkbox"
                        checked={deleteVisitsIncludeDispatched}
                        onChange={e => setDeleteVisitsIncludeDispatched(e.target.checked)}
                        className="w-4 h-4 rounded border-hairline"
                        data-testid="delete-visits-include-dispatched"
                      />
                      Also delete dispatched / en-route / in-progress visits
                    </label>
                  </div>
                  <div>
                    <label className={lbl}>Type DELETE to enable the button</label>
                    <input
                      type="text"
                      value={deleteVisitsConfirm}
                      onChange={e => setDeleteVisitsConfirm(e.target.value)}
                      placeholder="DELETE"
                      data-testid="delete-visits-confirm-input"
                      className={inp}
                      autoComplete="off"
                    />
                  </div>
                  <button
                    onClick={deleteScheduledVisits}
                    disabled={deletingVisits || deleteVisitsConfirm !== 'DELETE'}
                    data-testid="delete-visits-button"
                    className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                  >
                    {deletingVisits ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    {deletingVisits ? 'Deleting...' : 'Delete scheduled visits'}
                  </button>
                  {deleteVisitsResult && !deleteVisitsResult.error && (
                    <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg p-3 text-xs">
                      <div className="font-semibold mb-1">✓ Deleted {deleteVisitsResult.deleted} visits</div>
                      <div className="text-emerald-700">
                        Statuses targeted: {(deleteVisitsResult.statuses_targeted || []).join(', ')}
                        {deleteVisitsResult.only_ical ? ' · iCal-sourced only' : ''}
                      </div>
                    </div>
                  )}
                  {deleteVisitsResult?.error && (
                    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-xs">
                      Delete failed: {deleteVisitsResult.error}
                    </div>
                  )}
                </div>
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
        {section === 'automation' && (
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
                      <input type="checkbox" checked={automationSettings.ical_auto_sync_enabled}
                        onChange={e => setAutomationSettings(s => ({ ...s, ical_auto_sync_enabled: e.target.checked }))}
                        className="w-4 h-4 rounded" />
                    </label>
                  </div>
                  {automationSettings.ical_auto_sync_enabled && (
                    <div className="mt-3">
                      <label className={lbl}>Sync Interval (minutes)</label>
                      <input type="number" min="5" max="240" value={automationSettings.ical_sync_interval}
                        onChange={e => setAutomationSettings(s => ({ ...s, ical_sync_interval: parseInt(e.target.value) || 15 }))}
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
                      <input type="checkbox" checked={automationSettings.gcal_auto_sync_enabled}
                        onChange={e => setAutomationSettings(s => ({ ...s, gcal_auto_sync_enabled: e.target.checked }))}
                        className="w-4 h-4 rounded" />
                    </label>
                  </div>
                  {automationSettings.gcal_auto_sync_enabled && (
                    <div className="mt-3">
                      <label className={lbl}>Sync Interval (minutes)</label>
                      <input type="number" min="5" max="240" value={automationSettings.gcal_sync_interval}
                        onChange={e => setAutomationSettings(s => ({ ...s, gcal_sync_interval: parseInt(e.target.value) || 10 }))}
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
                      <input type="checkbox" checked={automationSettings.recurring_auto_generate_enabled}
                        onChange={e => setAutomationSettings(s => ({ ...s, recurring_auto_generate_enabled: e.target.checked }))}
                        className="w-4 h-4 rounded" />
                    </label>
                  </div>
                  {automationSettings.recurring_auto_generate_enabled && (
                    <p className="text-xs text-ink-3 mt-1">Runs once every 24 hours. Override per schedule via the Pause button on the Schedule → Recurring tab.</p>
                  )}
                </div>

                <div className="border-t border-hairline pt-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="font-semibold text-ink">Invite customers to their cleanings</h3>
                      <p className="text-xs text-ink-3 mt-1">Add the customer (by email) to each cleaning's Google Calendar event, so they get an invite and see all their upcoming cleanings on their own calendar. Their copy never shows gate codes, crew, or internal notes.</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={automationSettings.invite_customers}
                        onChange={e => setAutomationSettings(s => ({ ...s, invite_customers: e.target.checked }))}
                        className="w-4 h-4 rounded" />
                    </label>
                  </div>
                  {automationSettings.invite_customers && (
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
        )}

        {/* === EMAIL SETTINGS SECTION === */}
        {section === 'email' && (
          <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
            <div className="max-w-2xl pt-6">
              <div className="mb-6">
                <h2 className="text-lg font-bold text-ink">Gmail Connection</h2>
                <p className="text-sm text-ink-2 mt-1">
                  Connect your Gmail to sync emails in Comms, auto-match senders to clients, and create leads from unknown contacts.
                </p>
              </div>

              {/* Status indicator */}
              <div className={`flex items-center gap-3 p-4 rounded-xl border mb-6 ${hasCredentials ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                {hasCredentials
                  ? <><CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" /><div><div className="text-sm font-medium text-emerald-800">Credentials Found</div><div className="text-xs text-emerald-600">{emailConfig.credentials_source === 'env' ? 'Using Railway environment variables (SMTP_USER / SMTP_PASS)' : 'Using saved database settings'}</div></div></>
                  : <><AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" /><div><div className="text-sm font-medium text-amber-800">Not Connected</div><div className="text-xs text-amber-600">Enter your Gmail address and App Password, or set SMTP_USER and SMTP_PASS env vars on Railway</div></div></>
                }
              </div>

              {/* Credentials form */}
              <div className="bg-panel border border-hairline rounded-xl p-5 space-y-4 mb-6">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Shield className="w-4 h-4 text-blue-500" /> Credentials
                </div>

                <div>
                  <label className={lbl}>Gmail Address</label>
                  <input value={emailConfig.smtp_user} onChange={e => setEmailConfig(c => ({ ...c, smtp_user: e.target.value }))}
                    placeholder="hello@maineclean.co"
                    className={inp} />
                </div>

                <div>
                  <label className={lbl}>App Password</label>
                  <input type="password" value={emailConfig.smtp_pass} onChange={e => setEmailConfig(c => ({ ...c, smtp_pass: e.target.value }))}
                    placeholder="16-character Google App Password"
                    className={inp} />
                  <p className="text-[11px] text-ink-3 mt-1">
                    Generate at Google Account → Security → 2-Step Verification → App Passwords
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>IMAP Host</label>
                    <input value={emailConfig.imap_host} onChange={e => setEmailConfig(c => ({ ...c, imap_host: e.target.value }))}
                      className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>IMAP Port</label>
                    <input value={emailConfig.imap_port} onChange={e => setEmailConfig(c => ({ ...c, imap_port: e.target.value }))}
                      className={inp} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>SMTP Host</label>
                    <input value={emailConfig.smtp_host} onChange={e => setEmailConfig(c => ({ ...c, smtp_host: e.target.value }))}
                      className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>SMTP Port</label>
                    <input value={emailConfig.smtp_port} onChange={e => setEmailConfig(c => ({ ...c, smtp_port: e.target.value }))}
                      className={inp} />
                  </div>
                </div>
              </div>

              {/* Sending identity */}
              <div className="bg-panel border border-hairline rounded-xl p-5 space-y-4 mb-6">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Plug className="w-4 h-4 text-purple-500" /> Sending Identity
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>From Name</label>
                    <input value={emailConfig.from_name} onChange={e => setEmailConfig(c => ({ ...c, from_name: e.target.value }))}
                      placeholder="Maine Cleaning Co."
                      className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>From Email</label>
                    <input value={emailConfig.from_email} onChange={e => setEmailConfig(c => ({ ...c, from_email: e.target.value }))}
                      placeholder="hello@maineclean.co"
                      className={inp} />
                  </div>
                </div>
              </div>

              {/* Auto-enrichment toggle */}
              <div className="bg-panel border border-hairline rounded-xl p-5 mb-6">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={emailConfig.email_auto_enrich === 'true'}
                    onChange={e => setEmailConfig(c => ({ ...c, email_auto_enrich: e.target.checked ? 'true' : 'false' }))}
                    className="w-4 h-4 rounded border-hairline text-blue-600 focus:ring-0" />
                  <div>
                    <div className="text-sm font-medium text-ink">Auto-create contacts from emails</div>
                    <div className="text-xs text-ink-3">When enabled, unknown email senders are automatically added as leads (like Twenty CRM)</div>
                  </div>
                </label>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3">
                <button onClick={saveEmailConfig} disabled={emailSaving}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                  {emailSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  Save Settings
                </button>
                <button onClick={testEmailConnection} disabled={testing}
                  className="flex items-center gap-2 bg-panel border border-hairline hover:bg-bg text-ink-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                  Test Connection
                </button>
              </div>

              {/* Test results */}
              {testResult && (
                <div className="mt-4 bg-panel border border-hairline rounded-xl p-4 space-y-2">
                  <div className="text-sm font-semibold text-ink">Connection Test Results</div>
                  {testResult.error ? (
                    <div className="flex items-center gap-2 text-sm text-red-600">
                      <AlertTriangle className="w-4 h-4" /> {testResult.error}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-sm">
                        {testResult.imap === 'connected'
                          ? <><CheckCircle className="w-4 h-4 text-emerald-500" /><span className="text-emerald-700">IMAP: Connected ({testResult.email_count} emails)</span></>
                          : <><AlertTriangle className="w-4 h-4 text-red-500" /><span className="text-red-600">IMAP: {testResult.imap}</span></>
                        }
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        {testResult.smtp === 'connected'
                          ? <><CheckCircle className="w-4 h-4 text-emerald-500" /><span className="text-emerald-700">SMTP: Connected (outbound email ready)</span></>
                          : <><AlertTriangle className="w-4 h-4 text-red-500" /><span className="text-red-600">SMTP: {testResult.smtp}</span></>
                        }
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* === CUSTOM FIELDS SECTION === */}
        {section === 'fields' && <>

        {/* Page header */}
        <div className="flex items-center justify-between px-4 sm:px-8 py-6 bg-panel border-b border-hairline">
          <div>
            <h1 className="text-lg font-bold text-ink">Custom Fields</h1>
            <p className="text-sm text-ink-2 mt-1">Add extra fields that appear on client, job, and invoice records</p>
          </div>
          <button onClick={openNew}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors shrink-0">
            <Plus className="w-3.5 h-3.5" /> Add field
          </button>
        </div>

        {/* Entity tabs */}
        <div className="flex items-center gap-1 px-4 sm:px-8 mb-6">
          {ENTITY_TABS.map(tab => (
            <button key={tab.key} onClick={() => { setEntityTab(tab.key); setPanel(null) }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${entityTab === tab.key ? 'bg-blue-600 text-white' : 'text-ink-3 hover:text-ink hover:bg-bg-2'}`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Field list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 sm:px-8 pb-6">

          {/* Table */}
          <div className="rounded-xl border border-hairline overflow-hidden bg-panel">
            {/* Header */}
            <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-hairline bg-bg">
              {['Field name', 'Type', 'Required', ''].map(h => (
                <div key={h} className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">{h}</div>
              ))}
            </div>

            {fields.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-10 h-10 rounded-xl bg-bg flex items-center justify-center mb-3">
                  <Settings2 className="w-5 h-5 text-ink-3" />
                </div>
                <p className="text-sm text-ink-3">No {currentEntity?.label.toLowerCase()} fields yet</p>
                <button onClick={openNew} className="mt-3 text-xs text-ink font-medium hover:underline">
                  Add the first one →
                </button>
              </div>
            ) : fields.map((field, idx) => (
              <div key={field.id}
                className={`group grid grid-cols-[2fr_1fr_1fr_auto] gap-4 items-center px-5 py-3.5 hover:bg-bg cursor-pointer transition-colors
                  ${idx < fields.length - 1 ? 'border-b border-hairline' : ''}
                  ${panel === field.id ? 'bg-bg' : ''}`}
                onClick={() => openEdit(field)}>

                <div className="flex items-center gap-2.5">
                  <GripVertical className="w-3.5 h-3.5 text-ink-3 opacity-0 group-hover:opacity-100" />
                  <span className="text-sm font-medium text-ink">{field.name}</span>
                  {field.field_type === 'select' && field.options?.length > 0 && (
                    <span className="text-[10px] text-ink-3">{field.options.length} options</span>
                  )}
                </div>

                <div>
                  <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${TYPE_BADGE[field.field_type] || TYPE_BADGE.text}`}>
                    {FIELD_TYPES.find(t => t.value === field.field_type)?.label || field.field_type}
                  </span>
                </div>

                <div className="text-xs text-ink-3">
                  {field.required ? <span className="text-red-500 font-medium">Required</span> : 'Optional'}
                </div>

                <div className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={e => { e.stopPropagation(); deleteField(field.id) }}>
                  <Trash2 className="w-3.5 h-3.5 text-ink-3 hover:text-red-500 transition-colors" />
                </div>
              </div>
            ))}
          </div>

          {fields.length > 0 && (
            <p className="text-xs text-ink-3 mt-4 px-1">
              These fields appear in the {currentEntity?.label.toLowerCase()} form and on every {currentEntity?.key} record.
            </p>
          )}
        </div>
        </>}
      </div>

      {/* Side panel */}
      {section === 'fields' && panel !== null && (
        <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[360px] sm:shrink-0 sm:border-l sm:border-hairline">
          <div className="flex items-center justify-between px-6 py-5 border-b border-hairline">
            <h2 className="text-sm font-semibold text-ink">
              {panel === 'new' ? 'New field' : 'Edit field'}
            </h2>
            <button onClick={closePanel}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-3 hover:text-ink-3 hover:bg-bg-2 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 p-6 space-y-5 overflow-y-auto scrollbar-thin">

            <div>
              <label className={lbl}>Field name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Pet name, Gate code…"
                className={inp} autoFocus />
            </div>

            <div>
              <label className={lbl}>Field type</label>
              <select value={form.field_type} onChange={e => setForm(f => ({ ...f, field_type: e.target.value }))}
                className={inp}>
                {FIELD_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {form.field_type === 'select' && (
              <div>
                <label className={lbl}>Options <span className="normal-case text-ink-3 font-normal">(one per line)</span></label>
                <textarea
                  value={form.options}
                  onChange={e => setForm(f => ({ ...f, options: e.target.value }))}
                  rows={5}
                  placeholder={"Option A\nOption B\nOption C"}
                  className={inp + ' resize-none font-mono text-xs'}
                />
              </div>
            )}

            <div>
              <label className={lbl}>Sort order</label>
              <input type="number" value={form.sort_order}
                onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
                className={inp} />
              <p className="text-[11px] text-ink-3 mt-1">Lower numbers appear first</p>
            </div>

            <label className="flex items-center gap-3 cursor-pointer py-1">
              <input type="checkbox" checked={form.required}
                onChange={e => setForm(f => ({ ...f, required: e.target.checked }))}
                className="w-4 h-4 rounded border-hairline text-ink focus:ring-0" />
              <div>
                <div className="text-sm font-medium text-ink">Required</div>
                <div className="text-xs text-ink-3">Must be filled in to save a record</div>
              </div>
            </label>

            {/* Preview */}
            <div className="rounded-xl border border-hairline bg-bg p-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-3">Preview</div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1.5">
                {form.name || 'Field name'}
              </div>
              <FieldPreview type={form.field_type} options={form.options} />
            </div>
          </div>

          <div className="p-5 border-t border-hairline">
            <button onClick={save} disabled={saving || !form.name.trim()}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
              {saving ? 'Saving…' : (panel === 'new' ? 'Create field' : 'Update field')}
            </button>
          </div>
        </div>
      )}

      <Toast toasts={toasts} />

      <AgentWidget
        pageContext="settings"
        prompts={[
          'What custom fields should I add for clients?',
          'Help me set up fields for job tracking',
          'Check the system health',
        ]}
      />
    </div>
  )
}

function FieldPreview({ type, options }) {
  const cls = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink-3 pointer-events-none'
  switch (type) {
    case 'textarea':
      return <textarea rows={2} placeholder="Long text…" className={cls + ' resize-none'} readOnly />
    case 'number':
      return <input type="number" placeholder="0" className={cls} readOnly />
    case 'date':
      return <input type="date" className={cls} readOnly />
    case 'select': {
      const opts = options.split('\n').map(s => s.trim()).filter(Boolean)
      return (
        <select className={cls} disabled>
          <option value="">Select…</option>
          {opts.map(o => <option key={o}>{o}</option>)}
        </select>
      )
    }
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 pointer-events-none">
          <input type="checkbox" className="w-4 h-4 rounded border-hairline" readOnly />
          <span className="text-sm text-ink-3">Yes / No</span>
        </label>
      )
    default:
      return <input type="text" placeholder="Text value…" className={cls} readOnly />
  }
}
