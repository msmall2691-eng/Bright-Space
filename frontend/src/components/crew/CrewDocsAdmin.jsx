/**
 * Crew page — training/docs library manager (crew app Phase 5).
 *
 * The office writes the docs the crew reads in their Learn tab: cleaning
 * standards, chemical guides, onboarding, policies. Plain text on purpose —
 * no attachments, no formatting toolbar — so writing one takes two minutes
 * and reading one works on a phone in a driveway. Unpublished = draft the
 * crew never sees; pinned floats to the top of their tab.
 *
 * Self-contained: owns its data (GET/POST/PATCH/DELETE /api/crew-docs).
 */
import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Pin, Plus, EyeOff } from 'lucide-react'
import { get, post, patch, del } from '../../api'
import { pushToast } from '../../utils/toastBus'
import { confirmDialog } from '../../utils/confirmBus'

const CATEGORIES = [
  ['training', 'Training'], ['how-to', 'How-to'], ['products', 'Products'],
  ['policy', 'Policy'], ['safety', 'Safety'], ['other', 'Other'],
]
const catLabel = (v) => (CATEGORIES.find(([k]) => k === v)?.[1]) || 'Other'

const EMPTY_FORM = { title: '', body: '', url: '', category: 'how-to', pinned: false, published: true }

export default function CrewDocsAdmin() {
  const [docs, setDocs] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null)   // null | 'new' | doc object
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    get('/api/crew-docs')
      .then(setDocs)
      .catch(e => setError(e.detail || e.message || 'Could not load docs'))
  }, [])
  useEffect(() => { load() }, [load])

  const openNew = () => { setForm(EMPTY_FORM); setEditing('new') }
  const openEdit = (d) => {
    setForm({ title: d.title, body: d.body, url: d.url || '', category: d.category, pinned: d.pinned, published: d.published })
    setEditing(d)
  }

  const save = async () => {
    if (!form.title.trim()) { pushToast({ type: 'error', message: 'Title is required' }); return }
    setSaving(true)
    try {
      if (editing === 'new') await post('/api/crew-docs', form)
      else await patch(`/api/crew-docs/${editing.id}`, form)
      setEditing(null); load()
    } catch (e) {
      pushToast({ type: 'error', message: e.detail || e.message || 'Could not save' })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (d) => {
    const ok = await confirmDialog(
      `"${d.title}" disappears from every cleaner's Learn tab. This can't be undone.`,
      { title: 'Delete this doc?', confirmLabel: 'Delete', danger: true },
    )
    if (!ok) return
    try { await del(`/api/crew-docs/${d.id}`); setEditing(null); load() }
    catch (e) { pushToast({ type: 'error', message: e.detail || e.message || 'Could not delete' }) }
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-bold text-ink flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-ink-3" /> Crew docs & training
          </h2>
          <p className="text-[12px] text-ink-3 mt-0.5">
            What the crew sees in their Learn tab — standards, product guides, policies.
          </p>
        </div>
        <button onClick={openNew}
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg transition-colors">
          <Plus className="w-4 h-4" /> New doc
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {docs && docs.length === 0 && (
        <div className="border border-dashed border-hairline rounded-xl p-6 text-center text-[13px] text-ink-3">
          Nothing yet. Start with the ones you repeat on the phone: bathroom standard,
          which product on which surface, what to do when a client's home.
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2.5">
        {(docs || []).map(d => (
          <button key={d.id} onClick={() => openEdit(d)}
            className="text-left bg-panel border border-hairline rounded-xl p-3 hover:border-indigo-300 transition-colors">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13.5px] font-semibold text-ink leading-snug">{d.title}</span>
              <span className="flex items-center gap-1 shrink-0">
                {d.pinned && <Pin className="w-3.5 h-3.5 text-amber-500" />}
                {!d.published && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-ink-3 bg-bg-2 border border-hairline rounded-full px-1.5 py-0.5">
                    <EyeOff className="w-3 h-3" /> Draft
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-ink-3">
              {catLabel(d.category)}{d.updated_by ? ` · ${d.updated_by}` : ''}
            </div>
          </button>
        ))}
      </div>

      {editing !== null && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
          onClick={() => { if (!saving) setEditing(null) }}>
          <div className="w-full max-w-lg bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-3 max-h-[90dvh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="text-base font-bold text-ink">
              {editing === 'new' ? 'New crew doc' : 'Edit crew doc'}
            </div>
            <label className="block">
              <span className="text-[12px] font-medium text-ink-2">Title</span>
              <input value={form.title} maxLength={200} autoFocus
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Bathroom standard, step by step"
                className="mt-1 w-full rounded-lg border border-hairline bg-bg px-3 py-2 text-sm text-ink focus:outline-none focus:border-indigo-400" />
            </label>
            <div className="flex items-center gap-2">
              <label className="block flex-1">
                <span className="text-[12px] font-medium text-ink-2">Category</span>
                <select value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-hairline bg-bg px-2.5 py-2 text-sm text-ink focus:outline-none">
                  {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2 mt-5">
                <input type="checkbox" checked={form.pinned}
                  onChange={e => setForm(f => ({ ...f, pinned: e.target.checked }))} />
                Pinned
              </label>
              <label className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2 mt-5">
                <input type="checkbox" checked={form.published}
                  onChange={e => setForm(f => ({ ...f, published: e.target.checked }))} />
                Published
              </label>
            </div>
            <label className="block">
              <span className="text-[12px] font-medium text-ink-2">Link (optional)</span>
              <input value={form.url} maxLength={500} type="url"
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https:// — a training video or manufacturer guide"
                className="mt-1 w-full rounded-lg border border-hairline bg-bg px-3 py-2 text-sm text-ink focus:outline-none focus:border-indigo-400" />
            </label>
            <label className="block">
              <span className="text-[12px] font-medium text-ink-2">Body</span>
              <textarea value={form.body} rows={10} maxLength={20000}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                placeholder={'Plain text. Blank lines make paragraphs; lines starting with "- " read as steps on the phone.'}
                className="mt-1 w-full rounded-lg border border-hairline bg-bg px-3 py-2 text-[13px] text-ink leading-relaxed focus:outline-none focus:border-indigo-400 resize-y" />
            </label>
            <div className="flex items-center justify-between gap-2 pt-1">
              {editing !== 'new' ? (
                <button onClick={() => remove(editing)} disabled={saving}
                  className="text-[12.5px] font-semibold text-red-600 hover:text-red-700 disabled:opacity-60">
                  Delete
                </button>
              ) : <span />}
              <div className="flex gap-2">
                <button onClick={() => setEditing(null)} disabled={saving}
                  className="text-[13px] font-semibold bg-panel border border-hairline text-ink-2 px-4 py-2 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
                  Cancel
                </button>
                <button onClick={save} disabled={saving}
                  className="text-[13px] font-semibold bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg disabled:opacity-60 transition-colors">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
