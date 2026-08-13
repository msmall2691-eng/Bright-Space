/**
 * Learn tab (crew app Phase 5) — the training/docs library, read side.
 *
 * Pinned docs first, then freshest; category chips filter. Tap a doc for a
 * full-screen reader: plain text, big line height, "- " lines render as a
 * bulleted step — readable in a driveway with gloves on. Content comes from
 * the office (Crew page → Crew docs); drafts never appear here.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BookOpen, ExternalLink, Pin } from 'lucide-react'
import { get } from '../../api'

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
    <div className="fixed inset-0 z-30 bg-bg overflow-y-auto">
      <div className="sticky top-0 bg-panel/95 backdrop-blur border-b border-hairline px-4 py-3 flex items-center gap-3">
        <button onClick={onClose} aria-label="Back"
          className="grid place-items-center w-9 h-9 rounded-lg bg-bg-2 text-ink-2 active:scale-95 transition-transform">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-ink leading-tight truncate">{doc.title}</div>
          <div className="text-[11px] text-ink-3">{CAT_LABELS[doc.category] || 'Other'}</div>
        </div>
      </div>
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
    </div>
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

  if (error) {
    return <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
  }
  if (!docs) return <div className="h-56 rounded-xl bg-bg-2 animate-pulse" />

  const cats = ['all', ...new Set(docs.map(d => d.category))]
  const shown = cat === 'all' ? docs : docs.filter(d => d.category === cat)

  if (docs.length === 0) {
    return (
      <div className="text-center py-12">
        <BookOpen className="w-7 h-7 text-ink-3 mx-auto mb-2" />
        <p className="text-[14px] font-semibold text-ink">No guides yet</p>
        <p className="text-[12px] text-ink-3 mt-1">
          The office hasn't posted any training docs — check back soon.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {cats.length > 2 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
          {cats.map(c => (
            <button key={c} onClick={() => setCat(c)}
              className={`shrink-0 text-[12px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                cat === c ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-panel border-hairline text-ink-2'}`}>
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
                {d.pinned && <Pin className="w-3.5 h-3.5 text-amber-500" />}
              </span>
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5">{CAT_LABELS[d.category] || 'Other'}</div>
          </button>
        ))}
      </div>
      {open && <DocReader doc={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
