import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, X, User, Home, FileText, Calendar, Loader2,
  Receipt, LayoutGrid, Users, MessageSquare, LayoutDashboard, ArrowRight,
} from 'lucide-react'
import { get } from '../api'

// Global command palette. Opens on Cmd+/ (or Ctrl+/) or via the header search
// button. Twenty-style: it both *jumps* to records (search across clients,
// properties, invoices, jobs via /api/search) and *acts* (create a quote/invoice,
// schedule a job, jump to a section). Complements the AI bar (Cmd+K).

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

  const go = useCallback((path) => { setOpen(false); navigate(path) }, [navigate])

  // Quick actions — create + jump. `keywords` widen what the query matches.
  const ACTIONS = [
    { id: 'new-quote',   label: 'New quote',       icon: FileText,         keywords: 'create quote estimate', run: () => go('/quoting') },
    { id: 'new-invoice', label: 'New invoice',     icon: Receipt,          keywords: 'create invoice bill',    run: () => go('/invoicing') },
    { id: 'schedule',    label: 'Schedule a job',  icon: Calendar,         keywords: 'create job visit book',  run: () => go('/schedule') },
    { id: 'go-pipeline', label: 'Go to Pipeline',  icon: LayoutGrid,       keywords: 'deals opportunities',    run: () => go('/pipeline') },
    { id: 'go-clients',  label: 'Go to Clients',   icon: Users,            keywords: 'customers contacts',     run: () => go('/clients') },
    { id: 'go-inbox',    label: 'Go to Inbox',     icon: MessageSquare,    keywords: 'comms messages sms email', run: () => go('/comms') },
    { id: 'go-home',     label: 'Go to Dashboard', icon: LayoutDashboard,  keywords: 'home overview',          run: () => go('/') },
  ]

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
      } catch { setResults([]) }
      setLoading(false)
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  // Matching actions: all when empty, else filtered by label/keywords.
  const q = query.trim().toLowerCase()
  const actions = q
    ? ACTIONS.filter(a => (a.label + ' ' + a.keywords).toLowerCase().includes(q))
    : ACTIONS
  // Unified keyboard list: actions first, then search results.
  const items = [
    ...actions.map(a => ({ kind: 'action', ...a })),
    ...results.map(r => ({ kind: 'result', ...r })),
  ]
  useEffect(() => { setActive(0) }, [query, results.length])

  const choose = useCallback((item) => {
    if (!item) return
    if (item.kind === 'action') { item.run(); return }
    setOpen(false); navigate(item.path)
  }, [navigate])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]) }
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
            placeholder="Search records or run an action..."
            className="flex-1 text-sm outline-none placeholder:text-ink-3"
          />
          {loading && <Loader2 className="w-4 h-4 text-ink-3 animate-spin" />}
          <button onClick={() => setOpen(false)} className="p-1 text-ink-3 hover:text-ink-2">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[55vh] overflow-y-auto">
          {/* Actions section */}
          {actions.length > 0 && (
            <>
              <p className="px-5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Actions</p>
              {actions.map((a, i) => {
                const Icon = a.icon
                const idx = i // actions come first in `items`
                return (
                  <button
                    key={a.id}
                    onClick={() => choose({ kind: 'action', ...a })}
                    onMouseEnter={() => setActive(idx)}
                    className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${idx === active ? 'bg-bg' : 'hover:bg-bg'}`}
                  >
                    <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-bg-2 text-ink-2">
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span className="flex-1 text-sm font-medium text-ink truncate">{a.label}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                  </button>
                )
              })}
            </>
          )}

          {/* Search results section */}
          {query.trim() && results.length > 0 && (
            <p className="px-5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Records</p>
          )}
          {results.map((r, i) => {
            const meta = TYPE_META[r.type] || TYPE_META.client
            const Icon = meta.icon
            const idx = actions.length + i
            return (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => choose({ kind: 'result', ...r })}
                onMouseEnter={() => setActive(idx)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${idx === active ? 'bg-bg' : 'hover:bg-bg'}`}
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

          {query.trim() && !loading && results.length === 0 && actions.length === 0 && (
            <p className="px-5 py-6 text-sm text-ink-3 text-center">No matches for "{query.trim()}"</p>
          )}
        </div>

        <div className="px-5 py-2 border-t border-hairline flex items-center gap-3 text-[10px] text-ink-3">
          <span><kbd className="font-sans">↑↓</kbd> navigate</span>
          <span><kbd className="font-sans">↵</kbd> select</span>
          <span><kbd className="font-sans">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
