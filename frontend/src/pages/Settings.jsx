import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, X, GripVertical, Settings2, Mail, CheckCircle, AlertTriangle, Loader2, Shield, Plug } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { del, get, post, patch } from "../api"


const ENTITY_TABS = [
  { key: 'client',  label: 'Clients',  desc: 'Fields shown on every client record' },
  { key: 'job',     label: 'Jobs',     desc: 'Fields shown on every job / appointment' },
  { key: 'invoice', label: 'Invoices', desc: 'Fields shown on every invoice' },
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
  text:     'bg-zinc-100 text-zinc-500',
  number:   'bg-blue-50 text-blue-700',
  date:     'bg-violet-50 text-violet-700',
  select:   'bg-amber-50 text-amber-700',
  checkbox: 'bg-emerald-50 text-emerald-700',
  textarea: 'bg-zinc-100 text-zinc-500',
}

const EMPTY_FORM = { name: '', field_type: 'text', options: '', required: false, sort_order: 0 }

const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5'
const inp = 'w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder-gray-400 focus:outline-none focus:border-blue-400 transition-colors'

function Toast({ toasts }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-lg border pointer-events-auto
            ${t.type === 'success' ? 'bg-white border-zinc-200 text-zinc-900' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${t.type === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {t.message}
        </div>
      ))}
    </div>
  )
}

export default function Settings() {
  const [section, setSection] = useState('fields') // 'fields' | 'email'
  const [entityTab, setEntityTab] = useState('client')
  const [fields, setFields] = useState([])
  const [panel, setPanel] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [toasts, setToasts] = useState([])

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

  const currentEntity = ENTITY_TABS.find(t => t.key === entityTab)

  return (
    <div className="flex h-full">

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Header */}
        <div className="px-4 sm:px-8 py-6 border-b border-zinc-200 bg-white">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold text-zinc-900">Settings</h1>
              <p className="text-sm text-zinc-500 mt-1">Manage your account and integrations</p>
            </div>
          </div>
          <div className="flex bg-zinc-100 rounded-xl p-1 w-fit">
            <button onClick={() => setSection('fields')}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${section === 'fields' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}>
              <Settings2 className="w-3.5 h-3.5" /> Custom Fields
            </button>
            <button onClick={() => setSection('email')}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${section === 'email' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}>
              <Mail className="w-3.5 h-3.5" /> Email & Integrations
            </button>
          </div>
        </div>

        {/* === EMAIL SETTINGS SECTION === */}
        {section === 'email' && (
          <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-zinc-50">
            <div className="max-w-2xl pt-6">
              <div className="mb-6">
                <h2 className="text-lg font-bold text-zinc-900">Gmail Connection</h2>
                <p className="text-sm text-zinc-600 mt-1">
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
              <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4 mb-6">
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
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
                  <p className="text-[11px] text-zinc-400 mt-1">
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
              <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4 mb-6">
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
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
              <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-6">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={emailConfig.email_auto_enrich === 'true'}
                    onChange={e => setEmailConfig(c => ({ ...c, email_auto_enrich: e.target.checked ? 'true' : 'false' }))}
                    className="w-4 h-4 rounded border-zinc-300 text-blue-600 focus:ring-0" />
                  <div>
                    <div className="text-sm font-medium text-zinc-900">Auto-create contacts from emails</div>
                    <div className="text-xs text-zinc-400">When enabled, unknown email senders are automatically added as leads (like Twenty CRM)</div>
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
                  className="flex items-center gap-2 bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-700 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                  Test Connection
                </button>
              </div>

              {/* Test results */}
              {testResult && (
                <div className="mt-4 bg-white border border-zinc-200 rounded-xl p-4 space-y-2">
                  <div className="text-sm font-semibold text-zinc-900">Connection Test Results</div>
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
        <div className="flex items-center justify-between px-4 sm:px-8 py-6 bg-white border-b border-zinc-200">
          <div>
            <h1 className="text-lg font-bold text-zinc-900">Custom Fields</h1>
            <p className="text-sm text-zinc-600 mt-1">Add extra fields that appear on client, job, and invoice records</p>
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
                ${entityTab === tab.key ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100'}`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Field list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 sm:px-8 pb-6">

          {/* Table */}
          <div className="rounded-xl border border-zinc-200 overflow-hidden bg-white">
            {/* Header */}
            <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-gray-100 bg-zinc-50">
              {['Field name', 'Type', 'Required', ''].map(h => (
                <div key={h} className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{h}</div>
              ))}
            </div>

            {fields.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-10 h-10 rounded-xl bg-zinc-50 flex items-center justify-center mb-3">
                  <Settings2 className="w-5 h-5 text-gray-300" />
                </div>
                <p className="text-sm text-zinc-400">No {currentEntity?.label.toLowerCase()} fields yet</p>
                <button onClick={openNew} className="mt-3 text-xs text-zinc-900 font-medium hover:underline">
                  Add the first one →
                </button>
              </div>
            ) : fields.map((field, idx) => (
              <div key={field.id}
                className={`group grid grid-cols-[2fr_1fr_1fr_auto] gap-4 items-center px-5 py-3.5 hover:bg-zinc-50 cursor-pointer transition-colors
                  ${idx < fields.length - 1 ? 'border-b border-gray-100' : ''}
                  ${panel === field.id ? 'bg-zinc-50' : ''}`}
                onClick={() => openEdit(field)}>

                <div className="flex items-center gap-2.5">
                  <GripVertical className="w-3.5 h-3.5 text-gray-300 opacity-0 group-hover:opacity-100" />
                  <span className="text-sm font-medium text-zinc-900">{field.name}</span>
                  {field.field_type === 'select' && field.options?.length > 0 && (
                    <span className="text-[10px] text-zinc-400">{field.options.length} options</span>
                  )}
                </div>

                <div>
                  <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${TYPE_BADGE[field.field_type] || TYPE_BADGE.text}`}>
                    {FIELD_TYPES.find(t => t.value === field.field_type)?.label || field.field_type}
                  </span>
                </div>

                <div className="text-xs text-zinc-400">
                  {field.required ? <span className="text-red-500 font-medium">Required</span> : 'Optional'}
                </div>

                <div className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={e => { e.stopPropagation(); deleteField(field.id) }}>
                  <Trash2 className="w-3.5 h-3.5 text-zinc-400 hover:text-red-500 transition-colors" />
                </div>
              </div>
            ))}
          </div>

          {fields.length > 0 && (
            <p className="text-xs text-zinc-400 mt-4 px-1">
              These fields appear in the {currentEntity?.label.toLowerCase()} form and on every {currentEntity?.key} record.
            </p>
          )}
        </div>
        </>}
      </div>

      {/* Side panel */}
      {section === 'fields' && panel !== null && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[360px] sm:shrink-0 sm:border-l sm:border-zinc-200">
          <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-zinc-900">
              {panel === 'new' ? 'New field' : 'Edit field'}
            </h2>
            <button onClick={closePanel}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-500 hover:bg-zinc-100 transition-colors">
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
                <label className={lbl}>Options <span className="normal-case text-zinc-400 font-normal">(one per line)</span></label>
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
              <p className="text-[11px] text-zinc-400 mt-1">Lower numbers appear first</p>
            </div>

            <label className="flex items-center gap-3 cursor-pointer py-1">
              <input type="checkbox" checked={form.required}
                onChange={e => setForm(f => ({ ...f, required: e.target.checked }))}
                className="w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-0" />
              <div>
                <div className="text-sm font-medium text-zinc-900">Required</div>
                <div className="text-xs text-zinc-400">Must be filled in to save a record</div>
              </div>
            </label>

            {/* Preview */}
            <div className="rounded-xl border border-gray-100 bg-zinc-50 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-3">Preview</div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
                {form.name || 'Field name'}
              </div>
              <FieldPreview type={form.field_type} options={form.options} />
            </div>
          </div>

          <div className="p-5 border-t border-gray-100">
            <button onClick={save} disabled={saving || !form.name.trim()}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
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
  const cls = 'w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-400 pointer-events-none'
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
          <input type="checkbox" className="w-4 h-4 rounded border-zinc-300" readOnly />
          <span className="text-sm text-zinc-400">Yes / No</span>
        </label>
      )
    default:
      return <input type="text" placeholder="Text value…" className={cls} readOnly />
  }
}
