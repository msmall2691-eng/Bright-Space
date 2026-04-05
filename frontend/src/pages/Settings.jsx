import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, X, GripVertical, Settings2 } from 'lucide-react'

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
  text:     'bg-gray-100 text-gray-600',
  number:   'bg-blue-50 text-blue-700',
  date:     'bg-violet-50 text-violet-700',
  select:   'bg-amber-50 text-amber-700',
  checkbox: 'bg-emerald-50 text-emerald-700',
  textarea: 'bg-gray-100 text-gray-500',
}

const EMPTY_FORM = { name: '', field_type: 'text', options: '', required: false, sort_order: 0 }

const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5'
const inp = 'w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400 transition-colors'

function Toast({ toasts }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-lg border pointer-events-auto
            ${t.type === 'success' ? 'bg-white border-gray-200 text-gray-900' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${t.type === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {t.message}
        </div>
      ))}
    </div>
  )
}

export default function Settings() {
  const [entityTab, setEntityTab] = useState('client')
  const [fields, setFields] = useState([])
  const [panel, setPanel] = useState(null)   // null | 'new' | field-id
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [toasts, setToasts] = useState([])

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }, [])

  const load = useCallback(() =>
    fetch(`/api/fields?entity_type=${entityTab}`)
      .then(r => r.json()).then(setFields).catch(() => {}),
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
      const method = isNew ? 'POST' : 'PATCH'
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!r.ok) throw new Error()
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
      const r = await fetch(`/api/fields/${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error()
      await load()
      if (panel === id) closePanel()
      toast('Field deleted')
    } catch {
      toast('Failed to delete field', 'error')
    }
  }

  const currentEntity = ENTITY_TABS.find(t => t.key === entityTab)

  return (
    <div className="flex h-full">

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Page header */}
        <div className="flex items-center justify-between px-8 pt-7 pb-5">
          <div>
            <h1 className="text-[15px] font-semibold text-gray-900 tracking-tight">Custom Fields</h1>
            <p className="text-xs text-gray-400 mt-0.5">Define extra fields that appear on your records</p>
          </div>
          <button onClick={openNew}
            className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add field
          </button>
        </div>

        {/* Entity tabs */}
        <div className="flex items-center gap-1 px-8 mb-6">
          {ENTITY_TABS.map(tab => (
            <button key={tab.key} onClick={() => { setEntityTab(tab.key); setPanel(null) }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${entityTab === tab.key ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'}`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Field list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-8 pb-6">

          {/* Table */}
          <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
            {/* Header */}
            <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-gray-100 bg-gray-50">
              {['Field name', 'Type', 'Required', ''].map(h => (
                <div key={h} className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{h}</div>
              ))}
            </div>

            {fields.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center mb-3">
                  <Settings2 className="w-5 h-5 text-gray-300" />
                </div>
                <p className="text-sm text-gray-400">No {currentEntity?.label.toLowerCase()} fields yet</p>
                <button onClick={openNew} className="mt-3 text-xs text-gray-900 font-medium hover:underline">
                  Add the first one →
                </button>
              </div>
            ) : fields.map((field, idx) => (
              <div key={field.id}
                className={`group grid grid-cols-[2fr_1fr_1fr_auto] gap-4 items-center px-5 py-3.5 hover:bg-gray-50 cursor-pointer transition-colors
                  ${idx < fields.length - 1 ? 'border-b border-gray-100' : ''}
                  ${panel === field.id ? 'bg-gray-50' : ''}`}
                onClick={() => openEdit(field)}>

                <div className="flex items-center gap-2.5">
                  <GripVertical className="w-3.5 h-3.5 text-gray-300 opacity-0 group-hover:opacity-100" />
                  <span className="text-sm font-medium text-gray-900">{field.name}</span>
                  {field.field_type === 'select' && field.options?.length > 0 && (
                    <span className="text-[10px] text-gray-400">{field.options.length} options</span>
                  )}
                </div>

                <div>
                  <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${TYPE_BADGE[field.field_type] || TYPE_BADGE.text}`}>
                    {FIELD_TYPES.find(t => t.value === field.field_type)?.label || field.field_type}
                  </span>
                </div>

                <div className="text-xs text-gray-400">
                  {field.required ? <span className="text-red-500 font-medium">Required</span> : 'Optional'}
                </div>

                <div className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={e => { e.stopPropagation(); deleteField(field.id) }}>
                  <Trash2 className="w-3.5 h-3.5 text-gray-400 hover:text-red-500 transition-colors" />
                </div>
              </div>
            ))}
          </div>

          {fields.length > 0 && (
            <p className="text-xs text-gray-400 mt-4 px-1">
              These fields appear in the {currentEntity?.label.toLowerCase()} form and on every {currentEntity?.key} record.
            </p>
          )}
        </div>
      </div>

      {/* Side panel */}
      {panel !== null && (
        <div className="w-[360px] shrink-0 border-l border-gray-200 bg-white flex flex-col">
          <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">
              {panel === 'new' ? 'New field' : 'Edit field'}
            </h2>
            <button onClick={closePanel}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
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
                <label className={lbl}>Options <span className="normal-case text-gray-400 font-normal">(one per line)</span></label>
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
              <p className="text-[11px] text-gray-400 mt-1">Lower numbers appear first</p>
            </div>

            <label className="flex items-center gap-3 cursor-pointer py-1">
              <input type="checkbox" checked={form.required}
                onChange={e => setForm(f => ({ ...f, required: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-300 text-gray-900 focus:ring-0" />
              <div>
                <div className="text-sm font-medium text-gray-900">Required</div>
                <div className="text-xs text-gray-400">Must be filled in to save a record</div>
              </div>
            </label>

            {/* Preview */}
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-3">Preview</div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5">
                {form.name || 'Field name'}
              </div>
              <FieldPreview type={form.field_type} options={form.options} />
            </div>
          </div>

          <div className="p-5 border-t border-gray-100">
            <button onClick={save} disabled={saving || !form.name.trim()}
              className="w-full bg-gray-900 hover:bg-gray-800 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
              {saving ? 'Saving…' : (panel === 'new' ? 'Create field' : 'Update field')}
            </button>
          </div>
        </div>
      )}

      <Toast toasts={toasts} />
    </div>
  )
}

function FieldPreview({ type, options }) {
  const cls = 'w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-400 pointer-events-none'
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
          <input type="checkbox" className="w-4 h-4 rounded border-gray-300" readOnly />
          <span className="text-sm text-gray-400">Yes / No</span>
        </label>
      )
    default:
      return <input type="text" placeholder="Text value…" className={cls} readOnly />
  }
}
