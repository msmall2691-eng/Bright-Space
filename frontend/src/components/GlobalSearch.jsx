import { useState, useRef, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Search, X, User, Home, FileText, Calendar, Loader2, Clock, ArrowRight, CornerDownLeft,
} from 'lucide-react'
import { get } from '../api'
import { navItemsFor, createActionsFor, currentRole, iconFor } from '../nav/routes'
import { getRecents } from '../nav/recents'

// The quick switcher. Opens on Cmd+/ (or Ctrl+/) or via the sidebar/topbar
// search buttons. One box, four sources:
//   - empty query: Recents (last visited pages/records) + Create actions
//   - typing: Pages (fuzzy over the nav manifest) + Create actions + Records
//     (backend /api/search across clients, properties, invoices, jobs)
// Complements the AI bar (Cmd+K).

const TYPE_META = {
  client:   { icon: User,     label: 'Client' },
  property: { icon: Home,     label: 'Property' },
  invoice:  { icon: FileText, label: 'Invoice' },
  job:      { icon: Calendar, label: 'Job' },
}

function SectionLabel({ children }) {
  return <p className="px-5 pt-3 pb-1 text-[11px] font-medium text-ink-3">{children}</p>
}

function Row({ icon: Icon, title, subtitle, tag, active, onPick, onHover }) {
  return (
    <button
      onClick={onPick}
      onMouseEnter={onHover}
      className={`flex w-full items-center gap-3 px-5 py-2 text-left transition-colors ${active ? 'bg-bg-2' : 'hover:bg-bg-2'}`}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bg-2 text-ink-2">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{title}</span>
        {subtitle && <span className="block truncate text-[11px] text-ink-3">{subtitle}</span>}
      </span>
      {tag ? (
        <span className="shrink-0 text-[10px] font-medium text-ink-3">{tag}</span>
      ) : (
        <ArrowRight className={`h-3.5 w-3.5 shrink-0 text-ink-3 ${active ? '' : 'opacity-0'}`} />
      )}
    </button>
  )
}

export default function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const [recents, setRecents] = useState([])
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()

  const go = useCallback((path) => { setOpen(false); navigate(path) }, [navigate])

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
    if (open) {
      setRecents(getRecents())
      setTimeout(() => inputRef.current?.focus(), 30)
    } else {
      setQuery(''); setResults([]); setActive(0)
    }
  }, [open])

  // Debounced record search.
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

  const q = query.trim().toLowerCase()

  // Role-visible subsets — the switcher must not offer pages/creates the
  // caller's role can only 403 on (same filter the Sidebar applies).
  const role = currentRole()
  const navItems = navItemsFor(role)
  const createActions = createActionsFor(role)
  // Pages — fuzzy over the nav manifest (typing only; recents cover "empty").
  const pages = q ? navItems.filter(p => p.label.toLowerCase().includes(q)) : []
  // Create actions — all when empty, filtered by label/keywords when typing.
  const actions = q
    ? createActions.filter(a => (a.label + ' ' + a.keywords).toLowerCase().includes(q))
    : createActions
  // Skip the page we're on — "jump to where you already are" is noise.
  const shownRecents = q ? [] : recents.filter(r => r.to !== location.pathname).slice(0, 6)

  // One flat list drives the keyboard: recents → pages → actions → records.
  const items = [
    ...shownRecents.map(r => ({ kind: 'nav', to: r.to, title: r.label, icon: iconFor(r.to) })),
    ...pages.map(p => ({ kind: 'nav', to: p.to, title: p.label, icon: p.icon })),
    ...actions.map(a => ({ kind: 'nav', to: a.to, title: a.label, icon: a.icon })),
    ...results.map(r => ({ kind: 'record', to: r.path, title: r.title, subtitle: r.subtitle, type: r.type })),
  ]
  useEffect(() => { setActive(0) }, [query, results.length])

  const choose = useCallback((item) => { if (item) go(item.to) }, [go])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]) }
  }

  if (!open) return null

  // Section boundaries for rendering labels within the flat keyboard list.
  const pagesStart = shownRecents.length
  const actionsStart = pagesStart + pages.length
  const recordsStart = actionsStart + actions.length

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl overflow-hidden rounded-lg border border-hairline-2 bg-panel shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 border-b border-hairline px-5 py-3.5">
          <Search className="h-4 w-4 shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search records, jump to a page, or create…"
            className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-ink-3" />}
          <button onClick={() => setOpen(false)} className="min-h-0 p-1 text-ink-3 hover:text-ink-2">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Result list */}
        <div className="max-h-[55dvh] overflow-y-auto pb-1">
          {shownRecents.length > 0 && <SectionLabel>Recent</SectionLabel>}
          {shownRecents.map((r, i) => (
            <Row key={`re-${r.to}`} icon={iconFor(r.to)} title={r.label} tag=""
              active={i === active} onPick={() => choose(items[i])} onHover={() => setActive(i)} />
          ))}

          {pages.length > 0 && <SectionLabel>Pages</SectionLabel>}
          {pages.map((p, i) => (
            <Row key={`pg-${p.to}`} icon={p.icon} title={p.label}
              active={pagesStart + i === active}
              onPick={() => choose(items[pagesStart + i])} onHover={() => setActive(pagesStart + i)} />
          ))}

          {actions.length > 0 && <SectionLabel>Create</SectionLabel>}
          {actions.map((a, i) => (
            <Row key={`ac-${a.to}`} icon={a.icon} title={a.label}
              active={actionsStart + i === active}
              onPick={() => choose(items[actionsStart + i])} onHover={() => setActive(actionsStart + i)} />
          ))}

          {q && results.length > 0 && <SectionLabel>Records</SectionLabel>}
          {results.map((r, i) => {
            const meta = TYPE_META[r.type] || TYPE_META.client
            return (
              <Row key={`${r.type}-${r.id}`} icon={meta.icon} title={r.title} subtitle={r.subtitle} tag={meta.label}
                active={recordsStart + i === active}
                onPick={() => choose(items[recordsStart + i])} onHover={() => setActive(recordsStart + i)} />
            )
          })}

          {q && !loading && items.length === 0 && (
            <p className="px-5 py-6 text-center text-sm text-ink-3">No matches for "{query.trim()}"</p>
          )}
          {!q && shownRecents.length === 0 && (
            <p className="flex items-center gap-2 px-5 pt-3 pb-1 text-[11px] text-ink-3">
              <Clock className="h-3 w-3" /> Pages you visit will show up here.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-hairline px-5 py-2 text-[10px] text-ink-3">
          <span className="flex items-center gap-1"><kbd className="font-sans">↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="h-2.5 w-2.5" /> open</span>
          <span><kbd className="font-sans">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
