import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, X, GripVertical, Settings2 } from 'lucide-react'
import { del, get, patch, post } from '../../api'
import FieldPreview from './FieldPreview'
import {
  ENTITY_TABS, FIELD_TYPES, TYPE_BADGE, EMPTY_FORM, lbl, inp,
} from './constants'

/** Custom Fields tab — owns its own state (entity tab, fields list, panel,
 *  form, saving flag) and all four CRUD handlers. Layout constraint from
 *  Settings.jsx: the tab body sits inside the main column, but the side
 *  panel is a sibling of the main column. Solved by exposing the state
 *  from a hook + two render bodies the parent slots into the right places. */

export function useCustomFieldsTab({ toast }) {
  const [entityTab, setEntityTab] = useState('client')
  const [fields, setFields] = useState([])
  const [panel, setPanel] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() =>
    get(`/api/fields?entity_type=${entityTab}`).then(setFields).catch(err => console.error("[Settings]", err)),
    [entityTab]
  )
  useEffect(() => { load() }, [load])

  const openNew = () => { setForm({ ...EMPTY_FORM }); setPanel('new') }
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

  return {
    entityTab, setEntityTab,
    fields,
    panel, setPanel,
    form, setForm,
    saving,
    openNew, openEdit, closePanel, save, deleteField,
  }
}

export function CustomFieldsBody({ state }) {
  const { entityTab, setEntityTab, setPanel, fields, panel, openNew, openEdit, deleteField } = state
  const currentEntity = ENTITY_TABS.find(t => t.key === entityTab)
  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between px-4 sm:px-8 py-6 bg-panel border-b border-hairline">
        <div>
          <h1 className="text-lg font-bold text-ink">Custom Fields</h1>
          <p className="text-sm text-ink-2 mt-1">Add extra fields that appear on client, job, and invoice records</p>
        </div>
        <button onClick={openNew}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors shrink-0">
          <Plus className="w-3.5 h-3.5" /> Add field
        </button>
      </div>

      {/* Entity tabs */}
      <div className="flex items-center gap-1 px-4 sm:px-8 mb-6 overflow-x-auto scrollbar-thin">
        {ENTITY_TABS.map(tab => (
          <button key={tab.key} onClick={() => { setEntityTab(tab.key); setPanel(null) }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
              ${entityTab === tab.key ? 'bg-indigo-600 text-white' : 'text-ink-3 hover:text-ink hover:bg-bg-2'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Field list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 sm:px-8 pb-6">

        <div className="rounded-xl border border-hairline overflow-x-auto bg-panel">
          <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-hairline bg-bg min-w-[440px]">
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
              className={`group grid grid-cols-[2fr_1fr_1fr_auto] gap-4 items-center px-5 py-3.5 hover:bg-bg cursor-pointer transition-colors min-w-[440px]
                ${idx < fields.length - 1 ? 'border-b border-hairline' : ''}
                ${panel === field.id ? 'bg-bg' : ''}`}
              onClick={() => openEdit(field)}>

              <div className="flex items-center gap-2.5">
                {/* Drag handle: hover-only on desktop (won't drag on touch anyway). */}
                <GripVertical className="hidden sm:block w-3.5 h-3.5 text-ink-3 opacity-0 group-hover:opacity-100" />
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

              <button type="button"
                aria-label="Delete field"
                className="p-2 -m-2 rounded opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                onClick={e => { e.stopPropagation(); deleteField(field.id) }}>
                <Trash2 className="w-3.5 h-3.5 text-ink-3 hover:text-red-500 transition-colors" />
              </button>
            </div>
          ))}
        </div>

        {fields.length > 0 && (
          <p className="text-xs text-ink-3 mt-4 px-1">
            These fields appear in the {currentEntity?.label.toLowerCase()} form and on every {currentEntity?.key} record.
          </p>
        )}
      </div>
    </>
  )
}

export function CustomFieldsSidePanel({ state }) {
  const { panel, form, setForm, saving, closePanel, save } = state
  if (panel === null) return null
  return (
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
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
          {saving ? 'Saving…' : (panel === 'new' ? 'Create field' : 'Update field')}
        </button>
      </div>
    </div>
  )
}
