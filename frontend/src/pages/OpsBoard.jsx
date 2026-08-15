/**
 * Ops Board — the iOS-style triage dashboard (the new /dashboard home).
 *
 * Everything that needs the operator's attention, grouped into six clearable
 * sections with a stat-tile row, integration-status chips, per-severity filter
 * chips, and `/`-to-search. One fetch (`GET /api/dashboard/board`) drives the
 * whole page; the backend ships render-ready strings, so this file is a pure
 * view (see backend/services/board_service.py).
 *
 * Design: built entirely on the app's semantic tokens (bg / panel / ink /
 * hairline + the indigo accent), so it re-skins with the active theme and
 * lands the dark iOS look under `theme-console`. Sections are flat panels with
 * a header and hairline-divided rows; color is reserved for status, never
 * decoration. Cleared-state persists in localStorage (survives reload).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, RotateCcw, Eye, EyeOff, Check, ArrowRight, RefreshCw, Loader2, Sparkles,
} from 'lucide-react'
import { get, post } from '../api'
import { ErrorState } from '../components/ui'
import { TAG_TONE, SEV_DOT, SEV_LABEL, STAT_TONE, INT_DOT, SEV_ORDER } from '../components/board/tokens'
import BoardAssistant from '../components/board/BoardAssistant'

const CLEARED_KEY = 'brightbase_board_cleared'

/* ── localStorage cleared-set ─────────────────────────────────────────────── */
function loadCleared() {
  try { return new Set(JSON.parse(localStorage.getItem(CLEARED_KEY) || '[]')) }
  catch { return new Set() }
}
function persistCleared(set) {
  try { localStorage.setItem(CLEARED_KEY, JSON.stringify([...set])) } catch { /* ignore */ }
}

function fmtRefreshed(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  } catch { return '' }
}

function matchesQuery(it, q) {
  if (!q) return true
  const hay = `${it.title} ${it.body || ''} ${(it.tags || []).map(t => t.label).join(' ')}`.toLowerCase()
  return hay.includes(q)
}

/* ── Small pieces ─────────────────────────────────────────────────────────── */

function Tag({ tag }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-wide ${TAG_TONE[tag.tone] || TAG_TONE.gray}`}>
      {tag.label}
    </span>
  )
}

function StatTile({ stat, navigate }) {
  return (
    <button
      onClick={() => stat.href && navigate(stat.href)}
      className="rounded-xl border border-hairline bg-panel px-3 py-2.5 text-left transition-colors hover:border-hairline-2">
      <div className={`text-xl font-bold leading-none tabular-nums ${STAT_TONE[stat.tone] || STAT_TONE.neutral}`}>
        {stat.value}
      </div>
      <div className="mt-1 truncate text-[11px] font-semibold text-ink">{stat.label}</div>
      <div className="truncate text-[10px] text-ink-3">{stat.sub}</div>
    </button>
  )
}

function IntChip({ chip }) {
  return (
    <span
      title={`${chip.label} — ${chip.detail}`}
      className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
      <span className={`h-1.5 w-1.5 rounded-full ${INT_DOT[chip.tone] || INT_DOT.gray}`} />
      {chip.label}
      {chip.detail && <span className="text-ink-3">· {chip.detail}</span>}
    </span>
  )
}

function FilterChip({ sev, count, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
        active ? 'border-transparent bg-ink text-bg' : 'border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2'
      }`}>
      {sev !== 'all' && <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT[sev]}`} />}
      {SEV_LABEL[sev]}
      <span className={`tabular-nums ${active ? 'text-bg/70' : 'text-ink-3'}`}>{count}</span>
    </button>
  )
}

function BoardRow({ item, cleared, onToggle, onAction, actioningKey, confirmingKey }) {
  return (
    <div className={`flex items-start gap-2.5 px-3.5 py-2.5 transition-opacity ${cleared ? 'opacity-40' : ''}`}>
      <button
        onClick={() => onToggle(item.id)}
        aria-label={cleared ? 'Restore' : 'Clear'}
        className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border transition-colors ${
          cleared
            ? 'border-emerald-500 bg-emerald-500 text-white'
            : 'border-hairline-2 text-transparent hover:border-ink-3'
        }`}>
        <Check className="h-3 w-3" strokeWidth={3} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-[13px] font-semibold leading-snug text-ink ${cleared ? 'line-through' : ''}`}>
            {item.title}
          </p>
          {item.meta && <span className="shrink-0 pt-px text-[10px] font-medium tabular-nums text-ink-3">{item.meta}</span>}
        </div>
        {item.body && <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-ink-2">{item.body}</p>}
        {(item.tags?.length > 0 || item.actions?.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {item.tags?.map((t, i) => <Tag key={i} tag={t} />)}
            {item.actions?.length > 0 && (
              <div className="ml-auto flex items-center gap-1.5">
                {item.actions.map((a, i) => {
                  const key = `${item.id}:${a.label}`
                  if (a.kind !== 'api') {
                    return (
                      <button key={i} onClick={() => onAction(item, a)}
                        className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
                        {a.label}<ArrowRight className="h-3 w-3" />
                      </button>
                    )
                  }
                  const busy = actioningKey === key
                  const confirming = confirmingKey === key
                  return (
                    <button key={i} onClick={() => onAction(item, a)} disabled={busy}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-60 ${
                        confirming
                          ? 'border-rose-400 bg-rose-500/10 text-rose-600 dark:text-rose-300'
                          : 'border-hairline bg-bg-2 text-ink-2 hover:border-hairline-2 hover:text-ink'
                      }`}>
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      {confirming ? 'Confirm?' : a.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ section, items, clearedSet, onToggle, onAction, actioningKey, confirmingKey }) {
  if (!items.length) return null
  return (
    <section className="mb-4 break-inside-avoid overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none">{section.icon}</span>
        <h2 className="text-[11px] font-medium text-ink-3">{section.title}</h2>
        <span className="ml-auto rounded-full bg-bg-2 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-ink-3">
          {items.length}
        </span>
      </header>
      <div className="divide-y divide-hairline">
        {items.map(it => (
          <BoardRow key={it.id} item={it} cleared={clearedSet.has(it.id)} onToggle={onToggle}
            onAction={onAction} actioningKey={actioningKey} confirmingKey={confirmingKey} />
        ))}
      </div>
    </section>
  )
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function OpsBoard() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)

  const [cleared, setCleared] = useState(loadCleared)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [hideCleared, setHideCleared] = useState(false)
  const [note, setNote] = useState('')
  const [actioningKey, setActioningKey] = useState(null)
  const [confirmingKey, setConfirmingKey] = useState(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const searchRef = useRef(null)

  const load = useCallback(async (isRefresh) => {
    isRefresh ? setRefreshing(true) : setLoading(true)
    try {
      const res = await get('/api/dashboard/board')
      setData(res)
      setError(false)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // `/` focuses search; Esc clears it — matches the artifact's shortcuts.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery(''); searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleCleared = useCallback((id) => {
    setCleared(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      persistCleared(next)
      return next
    })
  }, [])

  const resetCleared = useCallback(() => {
    const empty = new Set()
    persistCleared(empty)
    setCleared(empty)
  }, [])

  const markCleared = useCallback((id) => {
    setCleared(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev); next.add(id); persistCleared(next); return next
    })
  }, [])

  // Run a card action. `link` navigates; `api` POSTs to an existing endpoint
  // right from the board — with a confirm step, a spinner, and an optimistic
  // clear on success. auto-assign can report it had no crew history to use.
  const runAction = useCallback(async (item, action) => {
    if (action.kind !== 'api') { navigate(action.href); return }
    const key = `${item.id}:${action.label}`
    if (action.confirm && confirmingKey !== key) { setConfirmingKey(key); return }
    setConfirmingKey(null); setActioningKey(key)
    try {
      const res = await post(action.endpoint, action.body || {})
      if (res && res.status && ['no_history', 'no_property'].includes(res.status)) {
        setNote(res.message || 'Could not complete automatically — open it to finish.')
      } else {
        if (action.clears) markCleared(item.id)
        setNote(`${action.done || 'Done'} — ${item.title}`)
      }
    } catch {
      setNote('That action failed — nothing was changed.')
    } finally {
      setActioningKey(null)
    }
  }, [confirmingKey, navigate, markCleared])

  const sections = data?.sections || []
  const allItems = useMemo(() => sections.flatMap(s => s.items), [sections])

  const counts = useMemo(() => {
    const c = { all: 0, urgent: 0, watch: 0, info: 0, good: 0, recurring: 0 }
    for (const it of allItems) { c.all += 1; c[it.severity] = (c[it.severity] || 0) + 1 }
    return c
  }, [allItems])

  const total = allItems.length
  const clearedCount = useMemo(
    () => allItems.reduce((n, it) => n + (cleared.has(it.id) ? 1 : 0), 0),
    [allItems, cleared],
  )

  const q = query.trim().toLowerCase()
  const visibleBySection = useMemo(() => {
    return sections.map(s => ({
      section: s,
      items: s.items.filter(it => {
        if (filter !== 'all' && it.severity !== filter) return false
        if (hideCleared && cleared.has(it.id)) return false
        if (q && !matchesQuery(it, q)) return false
        return true
      }),
    }))
  }, [sections, filter, hideCleared, cleared, q])

  const anyVisible = visibleBySection.some(v => v.items.length > 0)

  if (error && !loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <ErrorState title="Couldn't load the board"
          description="The server didn't respond. Check your connection and try again." onRetry={() => load()} />
      </div>
    )
  }

  const pct = total ? Math.round((clearedCount / total) * 100) : 0

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1440px] px-4 pb-10 pt-5 sm:px-6">

        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight text-ink">
                {data?.company || 'Ops Board'}
              </h1>
            </div>
            {data?.email && <p className="mt-0.5 truncate text-[12px] text-ink-3">{data.email}</p>}
          </div>
          <div className="flex items-center gap-2">
            {data?.refreshed_at && (
              <span className="hidden text-[11px] text-ink-3 sm:inline">refreshed {fmtRefreshed(data.refreshed_at)}</span>
            )}
            <button
              onClick={() => setAssistantOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2">
              <Sparkles className="h-3.5 w-3.5" /> Ask
            </button>
            <button
              onClick={() => load(true)}
              disabled={refreshing || loading}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          </div>
        </header>

        {note && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
            <Check className="h-4 w-4 shrink-0" /> <span className="min-w-0 flex-1 truncate">{note}</span>
            <button onClick={() => setNote('')} className="text-ink-3 hover:text-ink" aria-label="Dismiss">✕</button>
          </div>
        )}

        {/* Cleared progress */}
        <div className="mt-4 flex items-center gap-3">
          <span className="shrink-0 text-[12px] font-medium tabular-nums text-ink-3">
            {clearedCount} of {total} cleared
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-2">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => setHideCleared(v => !v)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 hover:bg-bg-2">
              {hideCleared ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {hideCleared ? 'Show cleared' : 'Hide cleared'}
            </button>
            <button
              onClick={resetCleared}
              disabled={!clearedCount}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-40">
              <RotateCcw className="h-3 w-3" /> Reset
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search everything…  (press /)"
            className="w-full rounded-xl border border-hairline bg-panel py-2.5 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-3 focus:border-indigo-500 focus:outline-none" />
        </div>

        {/* Filter chips */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SEV_ORDER.map(sev => (
            <FilterChip key={sev} sev={sev} count={counts[sev] || 0}
              active={filter === sev} onClick={() => setFilter(sev)} />
          ))}
        </div>

        {/* Integration chips */}
        {data?.integrations?.length > 0 && (
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {data.integrations.map(chip => <IntChip key={chip.key} chip={chip} />)}
          </div>
        )}

        {/* Stat tiles */}
        {loading ? (
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[68px] animate-pulse rounded-xl border border-hairline bg-panel" />
            ))}
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {(data?.stats || []).map(stat => <StatTile key={stat.key} stat={stat} navigate={navigate} />)}
          </div>
        )}

        {/* Sections (masonry) */}
        {loading ? (
          <div className="mt-5 columns-1 gap-4 lg:columns-2 xl:columns-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="mb-4 h-56 animate-pulse rounded-2xl border border-hairline bg-panel" />
            ))}
          </div>
        ) : anyVisible ? (
          <div className="mt-5 columns-1 gap-4 lg:columns-2 xl:columns-3">
            {visibleBySection.map(({ section, items }) => (
              <Section key={section.key} section={section} items={items}
                clearedSet={cleared} onToggle={toggleCleared}
                onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey} />
            ))}
          </div>
        ) : (
          <div className="mt-16 flex flex-col items-center justify-center text-center">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-emerald-500/10">
              <Check className="h-6 w-6 text-emerald-500" strokeWidth={2.5} />
            </div>
            <p className="mt-3 text-sm font-semibold text-ink">
              {total === 0 ? "You're all caught up" : query || filter !== 'all' ? 'No matches' : 'Everything cleared'}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-3">
              {total === 0
                ? 'Nothing needs your attention right now.'
                : query || filter !== 'all'
                  ? 'Try a different search or filter.'
                  : 'Nice work. Hit Reset to bring cleared items back.'}
            </p>
          </div>
        )}

        {/* Provenance footnote — mirrors the artifact's honesty about data sources. */}
        <p className="mt-8 text-[10.5px] leading-relaxed text-ink-3">
          Live from BrightBase — jobs, invoices, quotes, conversations and integration health.
          Check-offs are saved on this device. Twilio balance and Square deposits aren't live yet.
        </p>

        <BoardAssistant open={assistantOpen} onClose={() => setAssistantOpen(false)}
          sections={sections} navigate={navigate} />
      </div>
    </div>
  )
}
