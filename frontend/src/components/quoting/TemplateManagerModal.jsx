import { useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import { put } from '../../api'
import { SERVICE_TYPES } from './constants'

/** Right-side (bottom-sheet on mobile) template manager. Opens with a
 *  deep copy of the parent's quoteTemplates, lets the operator add / edit /
 *  reorder / delete templates + their line items, then PUTs the whole
 *  set back to /api/settings/quote-templates on save.
 *
 *  Owns all its own state internally — the seed comes in via `initial`,
 *  and on successful save the parent gets the saved list via
 *  `onSaved(templates)` so it can update its own quoteTemplates cache. */
export default function TemplateManagerModal({ initial, templatesLoaded, onClose, onSaved, toast }) {
  const [editTemplates, setEditTemplates] = useState(() =>
    initial.map(t => ({ ...t, items: (t.items || []).map(i => ({ ...i })) }))
  )
  const [savingTemplates, setSavingTemplates] = useState(false)

  const tplSlug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `tpl_${Date.now()}`
  const addTemplate = () => setEditTemplates(ts => [...ts, {
    id: `tpl_${Date.now()}`, label: '', service_type: 'residential',
    items: [{ name: '', description: '', qty: 1, unit_price: 0 }],
  }])
  const updateTemplate = (i, patch) => setEditTemplates(ts => ts.map((t, idx) => idx === i ? { ...t, ...patch } : t))
  const removeTemplate = (i) => setEditTemplates(ts => ts.filter((_, idx) => idx !== i))
  const updateTplItem = (ti, ii, patch) => setEditTemplates(ts => ts.map((t, idx) =>
    idx !== ti ? t : { ...t, items: t.items.map((it, j) => j === ii ? { ...it, ...patch } : it) }))
  const addTplItem = (ti) => setEditTemplates(ts => ts.map((t, idx) =>
    idx !== ti ? t : { ...t, items: [...t.items, { name: '', description: '', qty: 1, unit_price: 0 }] }))
  const removeTplItem = (ti, ii) => setEditTemplates(ts => ts.map((t, idx) =>
    idx !== ti ? t : { ...t, items: t.items.filter((_, j) => j !== ii) }))

  const saveTemplates = async () => {
    // Never save before the initial load settled — a PUT here would clobber the
    // stored templates with whatever the editor was seeded from (possibly []).
    if (!templatesLoaded) { toast('Templates are still loading — try again'); return }
    // Normalize + validate: each template needs a label and ≥1 named item.
    const cleaned = editTemplates.map(t => ({
      id: t.id || tplSlug(t.label),
      label: (t.label || '').trim(),
      title: (t.title || '').trim(),
      customer_message: (t.customer_message || '').trim(),
      service_type: t.service_type || 'residential',
      items: (t.items || []).filter(i => (i.name || '').trim()).map(i => ({
        name: i.name.trim(), description: i.description || '',
        qty: Number(i.qty) || 1, unit_price: Number(i.unit_price) || 0,
      })),
    }))
    for (const t of cleaned) {
      if (!t.label) { toast('Every template needs a name'); return }
      if (!t.items.length) { toast(`"${t.label}" needs at least one line item`); return }
    }
    setSavingTemplates(true)
    try {
      const res = await put('/api/settings/quote-templates', { templates: cleaned })
      onSaved(res?.templates || cleaned)
      toast('Templates saved ✓')
      onClose()
    } catch (e) { toast(e.message || 'Could not save templates') }
    setSavingTemplates(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center sm:justify-end">
      <div className="w-full sm:w-[520px] bg-panel sm:h-full shadow-2xl flex flex-col max-h-[92vh] sm:max-h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
          <div>
            <h2 className="font-semibold text-ink">Quote templates</h2>
            <p className="text-xs text-ink-3 mt-0.5">Reusable line-item sets for "Start from template" on new quotes.</p>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
          {editTemplates.length === 0 && <p className="text-sm text-ink-3 text-center py-6">No templates yet — add one below.</p>}
          {editTemplates.map((t, ti) => (
            <div key={ti} className="border border-hairline rounded-xl p-3 space-y-2 bg-bg">
              <div className="flex items-center gap-2">
                <input value={t.label} onChange={e => updateTemplate(ti, { label: e.target.value })}
                  placeholder="Template name (e.g. Biweekly Residential)"
                  className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                <select value={t.service_type} onChange={e => updateTemplate(ti, { service_type: e.target.value })}
                  className="bg-panel border border-hairline rounded-lg px-2 py-2 text-sm focus:outline-none">
                  {SERVICE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={() => removeTemplate(ti)} title="Delete template"
                  className="p-2 text-ink-3 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
              </div>
              {/* Templates carry the full customer experience: a default
                  quote title + customer message, applied to FUTURE quotes
                  when the template is picked (existing quotes untouched). */}
              <input value={t.title || ''} onChange={e => updateTemplate(ti, { title: e.target.value })}
                placeholder="Default quote title (optional — e.g. Biweekly cleaning)"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-400" />
              <textarea value={t.customer_message || ''} onChange={e => updateTemplate(ti, { customer_message: e.target.value })}
                placeholder="Default message to customer (optional)" rows={2}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-400 resize-none" />
              <div className="space-y-1.5">
                {(t.items || []).map((it, ii) => (
                  <div key={ii} className="flex items-center gap-1.5">
                    <input value={it.name} onChange={e => updateTplItem(ti, ii, { name: e.target.value })}
                      placeholder="Line item"
                      className="flex-1 bg-panel border border-hairline rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-blue-400" />
                    <input type="number" value={it.qty} onChange={e => updateTplItem(ti, ii, { qty: e.target.value })}
                      onFocus={e => e.target.select()}
                      title="Qty" className="w-14 bg-panel border border-hairline rounded-lg px-2 py-1.5 text-xs focus:outline-none" />
                    <input type="number" value={it.unit_price} onChange={e => updateTplItem(ti, ii, { unit_price: e.target.value })}
                      onFocus={e => e.target.select()}
                      title="Unit price" className="w-20 bg-panel border border-hairline rounded-lg px-2 py-1.5 text-xs focus:outline-none" />
                    <button onClick={() => removeTplItem(ti, ii)} className="p-1.5 text-ink-3 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => addTplItem(ti)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">+ Add line item</button>
              </div>
            </div>
          ))}
          <button onClick={addTemplate} className="w-full border border-dashed border-hairline rounded-xl py-2.5 text-sm text-ink-2 hover:bg-bg-2 transition-colors">
            + New template
          </button>
        </div>
        <div className="p-4 border-t border-hairline shrink-0 flex gap-2">
          <button onClick={onClose} className="flex-1 bg-bg-2 hover:bg-hairline text-ink-2 px-4 py-2.5 rounded-lg text-sm font-medium">Cancel</button>
          <button onClick={saveTemplates} disabled={savingTemplates}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-bg-2 text-white px-4 py-2.5 rounded-lg text-sm font-medium">
            {savingTemplates ? 'Saving…' : 'Save templates'}
          </button>
        </div>
      </div>
    </div>
  )
}
