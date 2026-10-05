/**
 * Ops Board — the /dashboard home.
 *
 * APPROVED LAYOUT (Oct 2026 rebuild). Top to bottom:
 *   1. FOCUS BAR — a greeting eyebrow + ONE headline for the single most
 *      pressing thing (unassigned-urgent coverage → overdue money → calm),
 *      derived from the board payload already fetched. One primary + one ghost
 *      action, hairline divider below.
 *   2. KPI STRIP — the trimmed stat tiles (TopBand), one compact quiet row.
 *   3. THREE-COLUMN GRID (3 cols at shell:, 2 mid, 1 on phone):
 *      A — Today (compact list of today's visits, from the SAME schedule-week
 *          fetch the old Home calendar used) + a quiet "needs a cleaner" card.
 *      B — Flow + Money summaries, DERIVED from the board payload (no fetch).
 *      C — the comms rail: Crew (one new fetch, /api/crew/threads) + Clients
 *          (the board payload's messages). Office-only.
 *   4. BELOW — Quick actions, Systems + Safe-to-Ignore (collapsed one-liners),
 *      the bench, then Notes + Ask Nova as the smallest last zone.
 *
 * ECONOMY. `GET /api/dashboard/board` drives the strip, the focus bar, the
 * Flow/Money summaries AND the Clients box (all derived client-side — no new
 * field, no new request). HomeToday reuses the one /api/schedule/week fetch the
 * Home calendar already made. The ONLY new call this page adds is CrewBox's
 * single `GET /api/crew/threads` on mount (+ a refetch after a crew send). No
 * polling loop is added; the shared summary poll (useUnreadCount) still drives
 * unread counts. Don't add an eager fetch here.
 *
 * Cleared-state persists in localStorage and now only serves the optimistic
 * clear of a resolved client row + the Systems/Safe-to-Ignore triage.
 *
 * Design: built entirely on the app's semantic tokens (bg / panel / ink /
 * hairline + the indigo accent); color is reserved for status, never
 * decoration — no filled pills, tinted resting banners, or count bubbles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check, ArrowRight, RefreshCw, Loader2, Sparkles, ChevronDown,
} from 'lucide-react'
import { get, post } from '../api'
import { ErrorState } from '../components/ui'
import { TAG_TONE, STAT_TONE, INT_DOT } from '../components/board/tokens'
import BoardAssistant from '../components/board/BoardAssistant'
import FocusBar from '../components/board/FocusBar'
import HomeToday from '../components/board/HomeToday'
import MiniListBox from '../components/board/MiniListBox'
import CrewBox from '../components/board/CrewBox'
import ClientsBox from '../components/board/ClientsBox'
import HomeWidgets from '../components/board/HomeWidgets'
import WhenVisible from '../components/board/WhenVisible'
import StickyNotes from '../components/board/StickyNotes'
import QuickActions from '../components/board/QuickActions'
import NovaChat from '../components/board/NovaChat'
import BenchDigest from '../components/BenchDigest'
import MarketplaceBoard from '../components/board/MarketplaceBoard'
import SubNav from '../components/ui/SubNav'
import { useUnreadCount } from '../hooks/useUnreadCount'
import { currentRole } from '../nav/routes'

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

/* ── Top stats band ───────────────────────────────────────────────────────── */
// Trim to the handful that actually moves the needle (owner: "smaller boxes...
// it's almost a little redundant"). We keep the four that nothing else on first
// paint answers.
const STAT_KEEP = new Set(['unassigned', 'overdue', 'leads', 'collected'])

/** ONE compact, quiet KPI row. Comms counts (from the shared summary poll — no
 *  extra request) lead since they're the most time-sensitive, then the board's
 *  trimmed stat tiles. Comms entries are admin+manager only. */
/* ── Shape-matched first paint ─────────────────────────────────────────────
 *
 * The focus bar and the KPI strip used to be gated behind `!loading`, so they
 * appeared out of nothing the moment the payload resolved and shoved the whole
 * grid down by about 160px — on the one screen whose job is to be read in a
 * hurry. And the grid's own placeholder was three `h-72` blocks: 288px each, so
 * 864px of pulse at phone width, taller than the viewport AND taller than the
 * content it stood in for.
 *
 * These reserve the real shape instead — same tiers, same corners, same row
 * rhythm — so nothing moves when the data lands. Every sibling page already
 * does this (ScheduleSkeleton, ClientProfileSkeleton, RecordSkeleton); the
 * board was the holdout. `aria-hidden` throughout: a screen reader should hear
 * the content, not the scaffolding.
 */
function SkelBar({ className = '' }) {
  return <div className={`animate-pulse rounded bg-hairline opacity-70 ${className}`} />
}

function FocusBarSkeleton() {
  return (
    <div aria-hidden="true" className="mt-4 border-b border-hairline pb-4">
      <SkelBar className="h-2.5 w-24" />
      <SkelBar className="mt-2.5 h-6 w-[min(22rem,80%)]" />
      <div className="mt-3 flex gap-2">
        <SkelBar className="h-8 w-28 rounded-lg" />
        <SkelBar className="h-8 w-20 rounded-lg" />
      </div>
    </div>
  )
}

function TopBandSkeleton() {
  return (
    <div aria-hidden="true"
      className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline shell:flex shell:items-stretch shell:gap-0 shell:divide-x shell:divide-hairline shell:bg-panel">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex flex-col items-start gap-1.5 bg-panel px-3.5 py-2.5 shell:flex-1">
          <SkelBar className="h-3.5 w-10" />
          <SkelBar className="h-2 w-16" />
        </div>
      ))}
    </div>
  )
}

function BoardGridSkeleton() {
  return (
    <div aria-hidden="true" className="mt-4 grid grid-cols-1 items-start gap-4 sm:grid-cols-2 shell:grid-cols-3">
      {Array.from({ length: 3 }).map((_, col) => (
        /* The third column is office-only and the last to matter, so it waits
           for sm: — that is what keeps the phone placeholder shorter than the
           viewport instead of three times taller. */
        <div key={col}
          className={`rounded-2xl border border-hairline bg-panel ${col === 2 ? 'hidden sm:block' : ''}`}>
          <div className="flex items-center gap-2 px-3.5 py-3">
            <SkelBar className="h-1.5 w-1.5 rounded-full" />
            <SkelBar className="h-2 w-20" />
          </div>
          {Array.from({ length: 3 }).map((_, row) => (
            <div key={row} className="border-t border-hairline px-3.5 py-2.5">
              <SkelBar className="h-2.5 w-[70%]" />
              <SkelBar className="mt-1.5 h-2 w-[45%]" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function TopBand({ stats, unreadConversations, crewUnreadThreads, showComms, navigate }) {
  const commsEntries = showComms ? [
    { key: 'unread', n: unreadConversations, label: 'unread messages', to: '/comms' },
    ...(crewUnreadThreads > 0
      ? [{ key: 'crew', n: crewUnreadThreads, label: 'crew chats', to: '/comms?view=crew' }]
      : []),
  ] : []
  const tiles = (stats || []).filter(s => STAT_KEEP.has(s.key))
  if (!commsEntries.length && !tiles.length) return null
  return (
    /* Wraps 2-up on a phone instead of scrolling sideways. It used to be one
       `overflow-x-auto` row of `min-w-[8.5rem]` tiles, which at 390px left two
       tiles permanently off-screen behind a scroller with no fade, no
       scrollbar and no affordance — so they were simply invisible, not hidden.
       The grid costs no height and loses nothing at shell:, where it goes back
       to a single divided row. `gap-px` over a hairline ground draws the
       dividers, so the 1px rules survive the wrap. */
    <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline shell:flex shell:items-stretch shell:gap-0 shell:divide-x shell:divide-hairline shell:bg-panel">
      {commsEntries.map(e => (
        <button key={e.key} onClick={() => navigate(e.to)}
          className="bb-focus flex flex-col items-start gap-0.5 bg-panel px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2 shell:min-w-0 shell:flex-1">
          <span className="flex items-center gap-1.5">
            {e.n > 0 && <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />}
            <span className={`text-[15px] font-bold leading-none tabular-nums ${e.n > 0 ? 'text-ink' : 'text-ink-3'}`}>
              {e.n}
            </span>
          </span>
          <span className="whitespace-nowrap text-[10.5px] text-ink-3">{e.label}</span>
        </button>
      ))}
      {tiles.map(stat => (
        <button key={stat.key}
          onClick={() => stat.href && navigate(stat.href)}
          title={stat.sub || undefined}
          className="bb-focus flex flex-col items-start gap-0.5 bg-panel px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2 shell:min-w-0 shell:flex-1">
          <span className={`text-[15px] font-bold leading-none tabular-nums ${STAT_TONE[stat.tone] || STAT_TONE.neutral}`}>
            {stat.value}
          </span>
          <span className="whitespace-nowrap text-[10.5px] text-ink-3">{stat.label}</span>
        </button>
      ))}
    </div>
  )
}

/* ── Small pieces ─────────────────────────────────────────────────────────── */

// Quiet dot + word — the owner vetoed the bubble labels. The dot carries the
// tone via bg-current, so TAG_TONE stays a single text-color map.
function Tag({ tag }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10.5px] font-medium ${TAG_TONE[tag.tone] || TAG_TONE.gray}`}>
      <span className="h-1 w-1 rounded-full bg-current opacity-70" aria-hidden />
      {tag.label}
    </span>
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

function BoardRow({ item, cleared, onToggle, onAction, actioningKey, confirmingKey }) {
  return (
    <div data-testid={`board-row-${item.id}`}
      className={`flex items-start gap-2.5 px-3.5 py-2.5 transition-opacity ${cleared ? 'opacity-40' : ''}`}>
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
                        className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
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

// Plumbing + inbox noise fold to one quiet line each by default.
const COLLAPSED_BY_DEFAULT = new Set(['systems', 'safe_to_ignore'])
// Only Safe-to-Ignore has a server-side bulk clear (the Gmail-triage delete-all).
const BULK_CLEARABLE = new Set(['safe_to_ignore'])

function collapsedHeading(key, n) {
  if (key === 'safe_to_ignore') return `${n} item${n === 1 ? '' : 's'} you can ignore`
  if (key === 'systems') return `${n} system notice${n === 1 ? '' : 's'}`
  return `${n} item${n === 1 ? '' : 's'}`
}

function Section({ section, items, clearedSet, onToggle, onAction, actioningKey, confirmingKey, setConfirmingKey, headerLink, navigate, onClearAll, clearingSection, filtersActive, maxRows }) {
  const [open, setOpen] = useState(() => !COLLAPSED_BY_DEFAULT.has(section.key))
  if (!items.length) return null
  const collapsible = COLLAPSED_BY_DEFAULT.has(section.key)
  const visibleItems = maxRows ? items.slice(0, maxRows) : items
  const hiddenCount = items.length - visibleItems.length
  const canClearAll = BULK_CLEARABLE.has(section.key) && !filtersActive
  const clearKey = `clear-section:${section.key}`
  const confirmingClear = confirmingKey === clearKey
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none">{section.icon}</span>
        {collapsible ? (
          <button onClick={() => setOpen(v => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <h2 className="text-[11px] font-medium text-ink-3">
              {collapsedHeading(section.key, items.length)}
            </h2>
            <ChevronDown className={`h-3 w-3 shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        ) : (
          <h2 className="text-[11px] font-medium text-ink-3">{section.title}</h2>
        )}
        {!collapsible && (
          <span className="ml-auto text-[11px] font-semibold tabular-nums text-ink-3">
            {items.length}
          </span>
        )}
        {canClearAll && (
          <button
            onClick={() => {
              if (confirmingClear) { onClearAll(section.key) } else { setConfirmingKey(clearKey) }
            }}
            disabled={clearingSection === section.key}
            className={`ml-auto shrink-0 text-[11px] font-semibold disabled:opacity-40 ${
              confirmingClear ? 'text-amber-700 dark:text-amber-400' : 'text-link hover:text-link'
            }`}>
            {clearingSection === section.key ? 'Clearing…' : confirmingClear ? 'Confirm?' : 'Clear all'}
          </button>
        )}
        {headerLink && (
          <button onClick={() => navigate(headerLink.to)}
            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
            {headerLink.label}<ArrowRight className="h-3 w-3" />
          </button>
        )}
      </header>
      {open && (
        <div className="divide-y divide-hairline">
          {visibleItems.map(it => (
            <BoardRow key={it.id} item={it} cleared={clearedSet.has(it.id)} onToggle={onToggle}
              onAction={onAction} actioningKey={actioningKey} confirmingKey={confirmingKey} />
          ))}
          {hiddenCount > 0 && (
            <button
              onClick={() => headerLink ? navigate(headerLink.to) : setOpen(true)}
              className="flex w-full items-center justify-center gap-1 px-3.5 py-2 text-[11.5px] font-medium text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2">
              +{hiddenCount} more{headerLink ? ` — ${headerLink.label}` : ''}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/* ── derivations from the board payload ───────────────────────────────────── */
function firstMoney(s) {
  const m = (s || '').match(/\$[\d,]+(?:\.\d+)?/)
  return m ? m[0] : s
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function OpsBoard() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)

  const [cleared, setCleared] = useState(loadCleared)
  // Messages/crew unread for the KPI strip (same summary poll the sidebar uses;
  // getCached dedupes the request — no new interval added here).
  const { unreadConversations, crewUnreadThreads } = useUnreadCount()
  const canComms = ['admin', 'manager'].includes(currentRole())
  const [note, setNote] = useState('')
  const [actioningKey, setActioningKey] = useState(null)
  const [confirmingKey, setConfirmingKey] = useState(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [clearingSection, setClearingSection] = useState(null)

  const firstName = useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem('brightbase_user') || '{}')
      const fn = (u.full_name || '').trim().split(/\s+/)[0]
      return fn || null
    } catch { return null }
  }, [])

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

  const toggleCleared = useCallback((id) => {
    setCleared(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      persistCleared(next)
      return next
    })
  }, [])

  const markCleared = useCallback((id) => {
    setCleared(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev); next.add(id); persistCleared(next); return next
    })
  }, [])

  // Run a card action. `link` navigates; `api` POSTs to an existing endpoint
  // with a confirm step, a spinner, an optimistic clear on success, and a
  // toast. An api response carrying an `href` also navigates there afterward.
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
        if (res && res.deleted && res.gmail_trashed === false && res.reason) {
          setNote(`Cleared from board — ${res.reason}`)
        } else {
          setNote(`${action.done || 'Done'} — ${item.title}`)
        }
        if (res && typeof res.href === 'string' && res.href.startsWith('/')) {
          navigate(res.href)
        }
      }
    } catch {
      setNote('That action failed — nothing was changed.')
    } finally {
      setActioningKey(null)
    }
  }, [confirmingKey, navigate, markCleared])

  const clearAllInSection = useCallback(async (sectionKey) => {
    setConfirmingKey(null)
    setClearingSection(sectionKey)
    try {
      const res = await post(`/api/inbox/triage/delete-all?section=${encodeURIComponent(sectionKey)}`, {})
      setNote(`Cleared ${res?.deleted ?? 0} item${res?.deleted === 1 ? '' : 's'}`)
      await load(true)
    } catch {
      setNote('Could not clear those — nothing was changed.')
    } finally {
      setClearingSection(null)
    }
  }, [load])

  const sections = data?.sections || []
  const byKey = useMemo(() => Object.fromEntries(sections.map(s => [s.key, s])), [sections])

  const messageItems = useMemo(() => byKey.messages?.items || [], [byKey])
  const needsCleanerItems = useMemo(() => byKey.needs_cleaner?.items || [], [byKey])
  const requestItems = useMemo(() => byKey.requests?.items || [], [byKey])
  const moneyItems = useMemo(() => byKey.money?.items || [], [byKey])

  // Flow summary — pipeline counts derived from the board payload's item lists
  // (no pipeline fetch). Each row links out to the Flow page that owns it.
  const flowRows = useMemo(() => {
    const leads = requestItems.filter(it => it.id.startsWith('lead:')).length
    const ready = requestItems.filter(it => it.id.startsWith('quote-stranded:')).length
    const overdueInv = moneyItems.filter(it => it.id.startsWith('invoice:')).length
    return [
      leads && { label: 'New leads', value: leads, to: '/flow', dot: 'bg-amber-500' },
      ready && { label: 'Ready to book', value: ready, to: '/flow', dot: 'bg-rose-500' },
      overdueInv && { label: 'Overdue invoices', value: overdueInv, to: '/flow', dot: 'bg-rose-500' },
    ].filter(Boolean)
  }, [requestItems, moneyItems])

  // Money summary — Outstanding + Collected today from the board payload.
  // (A "To send" / draft-invoices count isn't in the board payload — see the
  // follow-up note in the PR; designed around what's shipped.)
  const moneyRows = useMemo(() => {
    const outstanding = moneyItems.find(it => it.id === 'money:outstanding')
    const collected = (data?.stats || []).find(s => s.key === 'collected')
    const rows = []
    if (outstanding) rows.push({ label: 'Outstanding', value: firstMoney(outstanding.title), to: '/billing?view=invoices' })
    if (collected && collected.value && collected.value !== '$0') {
      rows.push({ label: 'Collected today', value: collected.value, to: '/billing?view=invoices', dot: 'bg-emerald-500' })
    }
    return rows
  }, [moneyItems, data])

  // Whether the middle column (Flow + Money) has anything to show. Both
  // MiniListBoxes self-hide when empty, so on a quiet morning this column would
  // render as a blank track in the middle of the grid — the lopsided "empty
  // space" the owner flagged. When it's empty we drop the column entirely and
  // the grid narrows to Today + comms, so there is never a hole (see the grid).
  const showFlowMoney = flowRows.length > 0 || moneyRows.length > 0

  // The single most pressing thing for the focus headline.
  const focus = useMemo(() => {
    const n = needsCleanerItems.length
    if (n > 0) return {
      tone: 'attention',
      headline: `${n} ${n === 1 ? 'job' : 'jobs'} still ${n === 1 ? 'needs' : 'need'} a cleaner`,
      primary: { label: 'See schedule', to: '/schedule?view=dispatch' },
      ghost: { label: 'Open Flow', to: '/flow' },
    }
    const overdue = (data?.stats || []).find(s => s.key === 'overdue')
    const oc = overdue ? (parseInt(overdue.value, 10) || 0) : 0
    if (oc > 0) return {
      tone: 'attention',
      headline: `${oc} ${oc === 1 ? 'invoice' : 'invoices'} overdue`,
      primary: { label: 'Chase', to: '/billing?view=invoices&status=overdue' },
    }
    return { tone: 'calm', headline: "You're on top of it this morning." }
  }, [needsCleanerItems, data])

  const systemsSection = byKey.systems
  const safeSection = byKey.safe_to_ignore

  if (error && !loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <ErrorState title="Couldn't load the board"
          description="The server didn't respond. Check your connection and try again." onRetry={() => load()} />
      </div>
    )
  }

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-[1440px] px-4 pb-10 pt-5 sm:px-6">

        {/* Slim top bar: identity + Ask/Refresh. The focus bar below is the hero. */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-[13px] font-semibold tracking-tight text-ink-2">
              {data?.company || 'Ops Board'}
            </h1>
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

        <div className="mt-3">
          <SubNav />
        </div>

        {/* 1 — FOCUS BAR */}
        {loading
          ? <FocusBarSkeleton />
          : <FocusBar firstName={firstName} focus={focus} navigate={navigate} />}

        {/* 2 — KPI STRIP */}
        {loading ? <TopBandSkeleton /> : (
          <TopBand stats={data?.stats}
            unreadConversations={unreadConversations}
            crewUnreadThreads={crewUnreadThreads}
            showComms={canComms}
            navigate={navigate} />
        )}

        {note && (
          /* Quiet hairline card + emerald check — not a tinted banner. */
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-hairline bg-panel px-3 py-2 text-[12px] font-medium text-ink-2">
            <Check className="h-4 w-4 shrink-0 text-emerald-500" /> <span className="min-w-0 flex-1 truncate">{note}</span>
            <button onClick={() => setNote('')} className="text-ink-3 hover:text-ink" aria-label="Dismiss">✕</button>
          </div>
        )}

        {loading ? <BoardGridSkeleton /> : (
          <>
            {/* 3 — THREE-COLUMN GRID. Per-column flex stacks so a short box packs
                onto the next instead of height-locking to the tallest in its row
                (owner: "too much empty spaces"). The middle column collapses out
                entirely when Flow + Money are both empty, so the grid is never
                left with a blank track (owner: Home "looks empty/awkward"). */}
            <div data-testid="home-grid"
              className={`mt-4 grid grid-cols-1 items-start gap-4 sm:grid-cols-2 bb-board-in ${
                showFlowMoney
                  ? 'shell:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.15fr)]'
                  : 'shell:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)]'
              }`}>

              {/* Column A — Today + needs-a-cleaner. Spans the full width at the
                  2-col (sm) size when the middle column is gone, so Today never
                  sits beside an empty cell. */}
              <div className={`flex flex-col gap-4 ${showFlowMoney ? '' : 'sm:col-span-2 shell:col-span-1'}`}>
                <HomeToday navigate={navigate} />
                {needsCleanerItems.length > 0 && (
                  <div className="flex items-center gap-2.5 rounded-2xl border border-hairline bg-panel px-3.5 py-3">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
                      <span className="font-semibold text-ink">{needsCleanerItems.length}</span>
                      {' '}{needsCleanerItems.length === 1 ? 'job' : 'jobs'} still {needsCleanerItems.length === 1 ? 'needs' : 'need'} a cleaner
                    </span>
                    <button onClick={() => navigate('/schedule?view=dispatch')}
                      className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
                      Open to crew<ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>

              {/* Column B — Flow + Money. Dropped entirely when both are empty
                  (each MiniListBox already self-hides) so the grid narrows
                  rather than showing a blank middle track. */}
              {showFlowMoney && (
                <div className="flex flex-col gap-4">
                  <MiniListBox title="Flow" link={{ label: 'Open Flow', to: '/flow' }} rows={flowRows} navigate={navigate} />
                  <MiniListBox title="Money" link={{ label: 'Billing', to: '/billing' }} rows={moneyRows} navigate={navigate} />
                </div>
              )}

              {/* Column C — the comms rail. Office-only: both /api/crew/threads
                  and /api/comms/* are admin/manager, so the whole rail is hidden
                  for roles that would 403. Spans both tracks at the mid (2-col)
                  width, its own track at shell:. */}
              {canComms && (
                <div data-testid="home-comms-rail" className="flex flex-col gap-4 sm:col-span-2 shell:col-span-1">
                  <CrewBox navigate={navigate} />
                  <ClientsBox items={messageItems} cleared={cleared} onAction={runAction}
                    actioningKey={actioningKey} confirmingKey={confirmingKey} navigate={navigate} />
                </div>
              )}
            </div>

            {/* 4 — BELOW THE GRID (demoted, nothing lost) */}

            {/* Quick actions — office-only (every create flow is a write). */}
            {canComms && (
              <div className="mt-4 bb-board-in" style={{ animationDelay: '60ms' }}>
                <QuickActions navigate={navigate} />
              </div>
            )}

            {/* Your widgets — Notes + Ask Nova, arrange them to taste (drag the
                grip / arrow keys, saved on this device). Promoted up here from
                the old last-and-smallest slot so your notes are front and
                centre, right under the quick actions. */}
            <div className="mt-4 bb-board-in" style={{ animationDelay: '90ms' }}>
              <HomeWidgets items={[
                { key: 'notes', label: 'Notes', node: <StickyNotes /> },
                canComms && { key: 'nova', label: 'Ask Nova', node: <NovaChat navigate={navigate} /> },
              ].filter(Boolean)} />
            </div>

            {/* Systems + Safe to Ignore — one quiet collapsed line each. */}
            {((systemsSection?.items.length || 0) > 0 || (safeSection?.items.length || 0) > 0) && (
              <div className="mt-4 flex flex-col gap-4 bb-board-in" style={{ animationDelay: '80ms' }}>
                {[systemsSection, safeSection].filter(s => s && s.items.length > 0).map(section => (
                  <Section key={section.key} section={section} items={section.items}
                    clearedSet={cleared} onToggle={toggleCleared}
                    onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                    navigate={navigate}
                    onClearAll={clearAllInSection} clearingSection={clearingSection}
                    setConfirmingKey={setConfirmingKey} filtersActive={false}
                    maxRows={6} />
                ))}
              </div>
            )}

            {/* The bench — who's asking for work + the week's round-up. Both
                fetch themselves, so both wait until scrolled to (WhenVisible).
                Neither approves here — the office says yes on the marketplace
                page itself (brightbase-marketplace guard). */}
            <div data-testid="home-bento"
              className="mt-4 grid grid-cols-1 gap-4 shell:grid-cols-2 bb-board-in"
              style={{ animationDelay: '100ms' }}>
              <WhenVisible minHeight="12rem">
                <MarketplaceBoard />
              </WhenVisible>
              <WhenVisible minHeight="12rem">
                <BenchDigest />
              </WhenVisible>
            </div>

          </>
        )}

        {/* Plumbing status lives at the bottom — useful, never front and center. */}
        {!loading && data?.integrations?.length > 0 && (
          <div className="mt-8 flex gap-1.5 overflow-x-auto pb-1">
            {data.integrations.map(chip => <IntChip key={chip.key} chip={chip} />)}
          </div>
        )}

        <p className="mt-3 text-[10.5px] leading-relaxed text-ink-3">
          Live from BrightBase — jobs, invoices, quotes, conversations and integration health.
          Check-offs are saved on this device. Twilio balance isn't live yet.
        </p>

        <BoardAssistant open={assistantOpen} onClose={() => setAssistantOpen(false)}
          sections={sections} navigate={navigate} onActed={() => load(true)} />
      </div>
    </div>
  )
}
