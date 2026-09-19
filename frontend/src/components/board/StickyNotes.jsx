import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, X, RefreshCw } from 'lucide-react'
import { get, post, patch, del } from '../../api'

/**
 * Sticky notes on Home — saved to the member's account (/api/notes), so they
 * follow them across devices rather than living in one browser. Add, edit,
 * recolor and delete; each write hits the API and updates locally.
 *
 * The soft paper tints are the note metaphor the owner asked for — deliberately
 * distinct from the status chrome the app keeps quiet. Kept muted, and each
 * tint has a dark-mode pairing so notes stay legible on either ground.
 */
const COLORS = ['amber', 'blue', 'green', 'pink']

// Muted paper tints (bg + border + swatch) for light and dark.
const TINT = {
  amber: 'bg-amber-50 border-amber-200/70 dark:bg-amber-500/10 dark:border-amber-500/20',
  blue: 'bg-blue-50 border-blue-200/70 dark:bg-blue-500/10 dark:border-blue-500/20',
  green: 'bg-emerald-50 border-emerald-200/70 dark:bg-emerald-500/10 dark:border-emerald-500/20',
  pink: 'bg-pink-50 border-pink-200/70 dark:bg-pink-500/10 dark:border-pink-500/20',
}
const SWATCH = { amber: 'bg-amber-400', blue: 'bg-blue-400', green: 'bg-emerald-400', pink: 'bg-pink-400' }

export default function StickyNotes() {
  const [notes, setNotes] = useState([])
  const [state, setState] = useState('loading')   // loading | ready | error
  const timers = useRef({})

  const load = () => {
    setState('loading')
    get('/api/notes')
      .then(rows => { setNotes(Array.isArray(rows) ? rows : []); setState('ready') })
      .catch(() => setState('error'))
  }
  useEffect(load, [])

  const add = useCallback(async () => {
    try {
      // Color varies with the current count (functional read to dodge staleness).
      let count = 0
      setNotes(prev => { count = prev.length; return prev })
      const n = await post('/api/notes', { body: '', color: COLORS[count % COLORS.length] })
      setNotes(prev => [n, ...prev])
      // Focus the new note's textarea on the next paint.
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-note="${n.id}"] textarea`)
        if (el) el.focus()
      })
    } catch { /* transient — the board just doesn't gain a note */ }
  }, [])

  // "Quick note" from the QuickActions widget adds a note without leaving Home.
  useEffect(() => {
    const h = () => add()
    window.addEventListener('bb:add-note', h)
    return () => window.removeEventListener('bb:add-note', h)
  }, [add])

  // Body edits save on a short debounce (and immediately on blur) so a burst of
  // keystrokes is one request, not one per character.
  const editBody = (id, body) => {
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, body } : n)))
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(() => saveBody(id, body), 600)
  }
  const saveBody = (id, body) => {
    clearTimeout(timers.current[id])
    patch(`/api/notes/${id}`, { body }).catch(() => { /* keep the local text; a reload reconciles */ })
  }

  const recolor = (id, color) => {
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, color } : n)))
    patch(`/api/notes/${id}`, { color }).catch(() => {})
  }

  const remove = (id) => {
    setNotes(prev => prev.filter(n => n.id !== id))
    del(`/api/notes/${id}`).catch(() => {})
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel" data-testid="home-sticky-notes">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none" aria-hidden="true">🗒️</span>
        <h2 className="text-[11px] font-medium text-ink-3">Notes</h2>
        <div className="ml-auto">
          <button onClick={add}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
      </header>

      {state === 'error' ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3 text-[12.5px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">Couldn't load your notes.</span>
          <button onClick={load} className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      ) : (
        <div className={`p-3 ${state === 'loading' ? 'animate-pulse opacity-60' : ''}`}>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {notes.map(n => (
              <div key={n.id} data-note={n.id}
                className={`group relative rounded-xl border p-2.5 pb-7 ${TINT[n.color] || TINT.amber}`}>
                <textarea
                  value={n.body}
                  onChange={e => editBody(n.id, e.target.value)}
                  onBlur={e => saveBody(n.id, e.target.value)}
                  rows={3}
                  placeholder="Write a note…"
                  className="w-full resize-none bg-transparent text-[12.5px] leading-snug text-ink placeholder-ink-3/70 focus:outline-none"
                />
                <div className="pointer-events-none absolute inset-x-2.5 bottom-1.5 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                  {COLORS.map(c => (
                    <button key={c} onClick={() => recolor(n.id, c)} title={c} aria-label={`Color ${c}`}
                      className={`h-3 w-3 rounded-full ring-1 ring-black/10 ${SWATCH[c]} ${n.color === c ? 'ring-2 ring-ink/40' : ''}`} />
                  ))}
                  <button onClick={() => remove(n.id)} title="Delete note" aria-label="Delete note"
                    className="ml-auto text-ink-3 hover:text-red-500">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}

            <button onClick={add}
              className="flex min-h-[76px] items-center justify-center gap-1.5 rounded-xl border border-dashed border-hairline-2 text-[12px] text-ink-3 transition-colors hover:border-indigo-500 hover:text-indigo-600">
              <Plus className="h-3.5 w-3.5" /> New note
            </button>
          </div>

          {state === 'ready' && notes.length === 0 && (
            <p className="mt-2 px-1 text-center text-[11.5px] text-ink-3">
              No notes yet — jot down anything you don't want to forget.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
