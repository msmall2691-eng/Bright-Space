import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, X, User, Home, FileText, Calendar, Loader2 } from 'lucide-react'
import { get } from '../api'

// Global cross-entity search palette. Opens on Cmd+/ (or Ctrl+/) or via the
// header search button (which dispatches the same shortcut). Searches clients,
// properties, invoices, and jobs through /api/search and navigates to the
// chosen result. Complements the AI bar (Cmd+K) rather than replacing it.

const TYPE_META = {
  client:   { icon: User,     label: 'Client',   color: 'text-blue-600 bg-blue-50' },
  property: { icon: Home,     label: 'Property', color: 'text-emerald-600 bg-emerald-50' },
  invoice:  { icon: FileText, label: 'Invoice',  color: 'text-violet-600 bg-violet-50' },
  job:      { icon: Calendar, label: 'Job',      color: 'text-amber-600 bg-amber-50' },
}

export default function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()

  // Open on Cmd+/ or Ctrl+/. Esc closes.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setOpen(v => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
    else { setQuery(''); setResults([]); setActive(0) }
  }, [open])

  // Debounced search.
  useEffect(() => {
    const term = query.trim()
    if (!term) { setResults([]); setLoading(false); return }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const data = await get(`/api/search?q=${encodeURIComponent(term)}`)
        setResults(data.results || [])
        setActive(0)
      } catch { setResults([]) }
      setLoading(false)
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  const choose = useCallback((r) => {
    if (!r) return
    setOpen(false)
    navigate(r.path)
  }, [navigate])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl bg-panel rounded-xl shadow-2xl border border-hairline/80 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-hairline">
          <Search className="w-5 h-5 text-ink-3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search clients, properties, invoices, jobs..."
            className="flex-1 text-sm outline-none placeholder:text-ink-3"
          />
          {loading && <Loader2 className="w-4 h-4 text-ink-3 animate-spin" />}
          <button onClick={() => setOpen(false)} className="p-1 text-ink-3 hover:text-ink-2">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[55vh] overflow-y-auto">
          {query.trim() && !loading && results.length === 0 && (
            <p className="px-5 py-6 text-sm text-ink-3 text-center">No matches for "{query.trim()}"</p>
          )}
          {!query.trim() && (
            <p className="px-5 py-6 text-xs text-ink-3 text-center">
              Type to search across clients, properties, invoices, and jobs.
            </p>
          )}
          {results.map((r, i) => {
            const meta = TYPE_META[r.type] || TYPE_META.client
            const Icon = meta.icon
            return (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => choose(r)}
                onMouseEnter={() => setActive(i)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${
                  i === active ? 'bg-bg' : 'hover:bg-bg'
                }`}
              >
                <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${meta.color}`}>
                  <Icon className="w-3.5 h-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink truncate">{r.title}</span>
                  {r.subtitle && <span className="block text-xs text-ink-3 truncate">{r.subtitle}</span>}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3 shrink-0">{meta.label}</span>
              </button>
            )
          })}
        </div>

        <div className="px-5 py-2 border-t border-hairline flex items-center gap-3 text-[10px] text-ink-3">
          <span><kbd className="font-sans">↑↓</kbd> navigate</span>
          <span><kbd className="font-sans">↵</kbd> open</span>
          <span><kbd className="font-sans">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
