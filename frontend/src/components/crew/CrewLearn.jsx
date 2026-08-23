/**
 * Learn tab (crew app Phase 5) — the training/docs library, read side.
 *
 * Order of the tab: Ask (the helper box) → My notes (a collapsed row —
 * private jottings) → Company guides, with the category filter sitting
 * directly above the list it filters. Tap a doc for a full-screen reader:
 * plain text, big line height, "- " lines render as a bulleted step —
 * readable in a driveway with gloves on. Content comes from the office
 * (Crew page → Crew docs); drafts never appear here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, ExternalLink, Pin, Plus, StickyNote, Trash2 } from 'lucide-react'
import { get, post, patch, del } from '../../api'
import { Skeleton } from '../ui'
import CrewAsk from './CrewAsk'
import { CrewCard, ErrorNote, FullScreenSheet, SectionLabel, SettingRow, Sheet } from './primitives'

/** "My notes" — the cleaner's PRIVATE notes (nobody else sees them, not
 *  even the office). Product codes, gate quirks, personal reminders.
 *  Renders as a collapsed row with the count; the list lives inside. */
function MyNotes() {
  const [notes, setNotes] = useState(null)
  const [editing, setEditing] = useState(null)   // null | 'new' | note
  const [form, setForm] = useState({ title: '', body: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    get('/api/crew/my-docs').then(setNotes).catch(() => setNotes([]))
  }, [])
  useEffect(() => { load() }, [load])

  const save = async () => {
    if (!form.title.trim()) return
    setBusy(true)
    try {
      if (editing === 'new') await post('/api/crew/my-docs', form)
      else await patch(`/api/crew/my-docs/${editing.id}`, form)
      setEditing(null); load()
    } catch { /* keep the sheet open; retry is natural */ }
    finally { setBusy(false) }
  }

  const remove = async (id) => {
    setBusy(true)
    try { await del(`/api/crew/my-docs/${id}`); setEditing(null); load() }
    catch { /* noop */ }
    finally { setBusy(false) }
  }

  return (
    <CrewCard className="px-4">
      <SettingRow icon={StickyNote} label={`My notes${notes?.length ? ` · ${notes.length}` : ''}`}
        summary="Private — only you see these">
        <div className="space-y-2">
          {(notes || []).map(n => (
            <button key={n.id} onClick={() => { setForm({ title: n.title, body: n.body }); setEditing(n) }}
              className="w-full text-left bg-bg border border-hairline rounded-xl px-3.5 py-2.5 active:scale-[0.99] transition-transform">
              <div className="text-[13px] font-semibold text-ink truncate">{n.title}</div>
              {n.body && <div className="text-[11.5px] text-ink-3 truncate">{n.body.split('\n')[0]}</div>}
            </button>
          ))}
          {notes?.length === 0 && (
            <p className="text-[12px] text-ink-3">
              Product codes, gate quirks, reminders — anything you want to keep handy.
            </p>
          )}
          <button onClick={() => { setForm({ title: '', body: '' }); setEditing('new') }}
            className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 inline-flex items-center gap-0.5">
            <Plus className="w-3.5 h-3.5" /> New note
          </button>
        </div>
      </SettingRow>
      {editing !== null && (
        <Sheet onClose={() => setEditing(null)} busy={busy}>
          <input value={form.title} maxLength={200} autoFocus
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Title"
            className="w-full rounded-lg border border-hairline bg-bg px-3 py-2 text-[14px] font-semibold text-ink focus:outline-none focus:border-blue-400" />
          <textarea value={form.body} rows={6} maxLength={20000}
            onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            placeholder="Your note — private to you."
            className="w-full rounded-lg border border-hairline bg-bg px-3 py-2 text-[13px] text-ink leading-relaxed focus:outline-none focus:border-blue-400 resize-none" />
          <div className="flex items-center justify-between gap-2">
            {editing !== 'new' ? (
              <button onClick={() => remove(editing.id)} disabled={busy}
                className="text-red-600 p-1.5" title="Delete"><Trash2 className="w-4 h-4" /></button>
            ) : <span />}
            <div className="flex gap-2">
              <button onClick={() => setEditing(null)} disabled={busy}
                className="text-[13px] font-semibold bg-panel border border-hairline text-ink-2 px-3.5 py-2 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
                Cancel
              </button>
              <button onClick={save} disabled={busy || !form.title.trim()}
                className="text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-2 rounded-lg disabled:opacity-60 transition-colors">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </CrewCard>
  )
}

const CAT_LABELS = {
  training: 'Training', 'how-to': 'How-to', products: 'Products',
  policy: 'Policy', safety: 'Safety', other: 'Other',
}

function DocReader({ doc, onClose }) {
  // Paragraphs split on blank lines; "- " lines inside a block render as
  // list items. That's the whole format — deliberately nothing richer.
  const blocks = useMemo(() =>
    (doc.body || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean), [doc.body])
  return (
    <FullScreenSheet title={doc.title} subtitle={CAT_LABELS[doc.category] || 'Other'} onClose={onClose}>
      <div className="max-w-lg mx-auto px-4 py-5 pb-16 space-y-4">
        {doc.url && (
          <a href={doc.url} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg transition-colors">
            <ExternalLink className="w-4 h-4" /> Open link
          </a>
        )}
        {blocks.length === 0 && !doc.url && <p className="text-[13px] text-ink-3">Nothing written yet.</p>}
        {blocks.map((block, i) => {
          const lines = block.split('\n')
          const isList = lines.every(l => l.trim().startsWith('- '))
          if (isList) {
            return (
              <ul key={i} className="space-y-1.5">
                {lines.map((l, j) => (
                  <li key={j} className="flex gap-2 text-[14px] text-ink-2 leading-relaxed">
                    <span className="text-ink-3 mt-[1px]">•</span>
                    <span className="min-w-0">{l.trim().slice(2)}</span>
                  </li>
                ))}
              </ul>
            )
          }
          return (
            <p key={i} className="text-[14px] text-ink-2 leading-relaxed whitespace-pre-wrap">
              {block}
            </p>
          )
        })}
      </div>
    </FullScreenSheet>
  )
}

export default function CrewLearn() {
  const [docs, setDocs] = useState(null)
  const [error, setError] = useState(null)
  const [cat, setCat] = useState('all')
  const [open, setOpen] = useState(null)

  useEffect(() => {
    get('/api/crew/docs')
      .then(setDocs)
      .catch(e => setError(e.detail || e.message || 'Could not load'))
  }, [])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!docs) return <Skeleton className="h-56 w-full rounded-xl" />

  const cats = ['all', ...new Set(docs.map(d => d.category))]
  const shown = cat === 'all' ? docs : docs.filter(d => d.category === cat)

  return (
    <div className="space-y-3">
      <CrewAsk />
      <MyNotes />

      <SectionLabel className="pt-1">Company guides</SectionLabel>

      {docs.length === 0 ? (
        <div className="text-center py-8">
          <BookOpen className="w-7 h-7 text-ink-3 mx-auto mb-2" />
          <p className="text-[14px] font-semibold text-ink">No guides yet</p>
          <p className="text-[12px] text-ink-3 mt-1">
            The office hasn't posted any training docs — check back soon.
          </p>
        </div>
      ) : (
        <>
          {cats.length > 2 && (
            /* The filter sits directly above the list it filters. */
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
              {cats.map(c => (
                <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c}
                  className={`shrink-0 text-[12px] font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                    cat === c ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-panel border-hairline text-ink-2 hover:bg-bg-2'}`}>
                  {c === 'all' ? 'All' : (CAT_LABELS[c] || c)}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {shown.map(d => (
              <button key={d.id} onClick={() => setOpen(d)}
                className="w-full text-left bg-panel border border-hairline rounded-xl px-3.5 py-3 shadow-glass-sm active:scale-[0.99] transition-transform">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-ink leading-snug min-w-0">{d.title}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {d.url && <ExternalLink className="w-3.5 h-3.5 text-ink-3" />}
                    {d.pinned && <Pin className="w-3.5 h-3.5 text-ink-3" />}
                  </span>
                </div>
                <div className="text-[11px] text-ink-3 mt-0.5">{CAT_LABELS[d.category] || 'Other'}</div>
              </button>
            ))}
          </div>
        </>
      )}
      {open && <DocReader doc={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
