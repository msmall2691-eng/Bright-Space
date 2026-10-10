/**
 * Ops Board — the /dashboard home.
 *
 * APPROVED LAYOUT (Oct 2026 rebuild). Top to bottom:
 *   1. FOCUS BAR — a greeting eyebrow + ONE headline for the single most
 *      pressing thing (unassigned-urgent coverage → overdue money), derived
 *      from the board payload already fetched. One primary + one ghost action,
 *      hairline divider below. On a quiet morning there is NO headline — see
 *      FocusBar; the reassurance sentence was retired.
 *   2. KPI STRIP — the trimmed stat tiles (TopBand), one compact quiet row.
 *   3. THREE-COLUMN GRID (3 cols at shell:, 2 mid, 1 on phone):
 *      A — Today (compact list of today's visits, from the SAME schedule-week
 *          fetch the old Home calendar used) + the needs-a-cleaner JOBS.
 *      B — incoming work, money, and anything broken: the board payload's own
 *          `requests` / `money` rows with the actions it already ships, plus
 *          problem-gated feed + recurring health from `snapshot`.
 *      C — the comms rail: Crew (one new fetch, /api/crew/threads) + Clients
 *          (the board payload's messages). Office-only.
 *   4. BELOW — Quick actions, Systems + Safe-to-Ignore (collapsed one-liners),
 *      the bench, then Notes + Ask Nova as the smallest last zone.
 *
 * ECONOMY. `GET /api/dashboard/board` drives the strip, the focus bar, every
 * row in the middle column, the two health boxes AND the Clients box (all from
 * the one payload — no new field, no new request; `snapshot` has been in it
 * since board_snapshot.py shipped, it was simply not mounted here). HomeToday
 * reuses the one /api/schedule/week fetch the Home calendar already made.
 * The ONLY new call this page adds is CrewBox's
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
import CrewBox from '../components/board/CrewBox'
import { FeedHealth, RecurringHealth } from '../components/board/SnapshotBoxes'
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
import { STATUS_TEXT, STATUS_ICON } from '../theme/statusText'

const CLEARED_KEY = 'brightbase_board_cleared'

// Column templates by how many of the grid's three columns have children.
// Spelled out as complete literals because Tailwind's JIT only emits classes it
// can see as whole strings — an interpolated track list gets purged.
//
// THREE TRACKS NEED A WINDOW THAT HOLDS THREE TRACKS, so the third one waits
// for xl:, not shell:. `shell:` is 900px and the sidebar plus the page gutters
// take ~290 of it, which leaves ~640px of content — about 184px a track once
// it is cut three ways. At that width a job title renders as "Cle…", a client
// as "+1207…", and every box header wraps; the board stops being glanceable,
// which is the entire point of it. (This never showed up before because
// BB-CSS-01 meant the template was overruled by `sm:grid-cols-2` and the grid
// quietly ran at two tracks everywhere. Fixing the breakpoint order is what
// made it visible — the three-track layout had simply never rendered.)
//
// At shell: the same three columns run two-up with the comms rail spanning
// underneath (it lays its own boxes out side by side there, so it is a row of
// the grid rather than a stubby full-width band). xl: is 1280px — ~970px of
// content, ~300px a track — which is where a third track starts to read.
const GRID_COLS = {
  1: 'shell:grid-cols-1',
  2: 'shell:grid-cols-[minmax(0,1.5fr)_minmax(0,1.15fr)]',
  3: 'shell:grid-cols-[minmax(0,1.5fr)_minmax(0,1.15fr)] xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1.15fr)_minmax(0,1.15fr)]',
}

// Endpoints that cost money per call. Every one of these gets a confirm step
// client-side, whether or not the payload shipped a `confirm` string.
const METERED = /^\/api\/ai\//

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
  // The phone grid is two across, so an ODD number of tiles leaves the last
  // cell empty — a tile-sized hole in the strip, on the smallest screen, in
  // the one element that is supposed to be a solid block of numbers. The usual
  // count is odd: four stats plus the unread-messages entry, with crew chats
  // only appearing when a crew thread is unread. The last tile takes the whole
  // row instead. No effect at shell:, where the strip is a flex row.
  const oddCount = (commsEntries.length + tiles.length) % 2 === 1
  const lastFills = oddCount ? 'col-span-2 shell:col-span-1' : ''
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
      {tiles.map((stat, i) => (
        <button key={stat.key}
          onClick={() => stat.href && navigate(stat.href)}
          title={stat.sub || undefined}
          className={`bb-focus flex flex-col items-start gap-0.5 bg-panel px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2 shell:min-w-0 shell:flex-1 ${
            i === tiles.length - 1 ? lastFills : ''}`}>
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

function BoardRow({ item, cleared, onToggle, onAction, actioningKey, confirmingKey, dismissable = true }) {
  return (
    <div data-testid={`board-row-${item.id}`}
      className={`flex items-start gap-2.5 px-3.5 py-2.5 transition-opacity ${cleared ? 'opacity-40' : ''}`}>
      {dismissable && (
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
      )}
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
                          ? `border-rose-400 bg-rose-500/10 ${STATUS_TEXT.problem}`
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
// Sections whose rows carry the check-off box. This is a per-DEVICE
// localStorage hide, not a state change on the record, so it belongs only
// where "I've seen this" is the whole point: a system notice you've read, a
// promo email you don't care about. It must NOT appear on work — a job with
// nobody on it and an invoice nobody has paid are things you fix, and a board
// that lets you tick away an overdue invoice on one laptop (while it stays on
// your phone) is a way to lose money. Those rows get their real actions
// instead: Open, Mark paid, Open to crew.
const DISMISSABLE = new Set(['systems', 'safe_to_ignore'])
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
  const dismissable = DISMISSABLE.has(section.key)
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
              confirmingClear ? STATUS_TEXT.attention : 'text-link hover:text-link'
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
            <BoardRow key={it.id} item={it} dismissable={dismissable}
              cleared={dismissable && clearedSet.has(it.id)} onToggle={onToggle}
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
    // Confirm when the payload asks for one, OR when the endpoint is metered.
    // `Draft quote` (/api/ai/quote-from-lead) ships WITHOUT a confirm string
    // (board_service.py), which was fine while it sat behind a page but is not
    // fine now that it's a one-tap button on the landing screen: every tap is
    // a billed Anthropic call, and a mis-tap costs money rather than a click.
    // brightbase-economy — a metered API is never a single accidental tap.
    if ((action.confirm || METERED.test(action.endpoint || '')) && confirmingKey !== key) {
      setConfirmingKey(key); return
    }
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

  // Plumbing health, PROBLEM-GATED. `build_snapshot` ships these inside the
  // board payload already, so mounting them costs no request. They render only
  // when something is actually wrong — a permanent "3/3 feeding" card is
  // furniture that never tells you anything (SnapshotBoxes' own rule), and both
  // components self-hide on a missing subject anyway. Gating on the PROBLEM
  // count rather than on the subject means a business with feeds sees this
  // column only on the mornings a feed broke.
  const feedSnap = data?.snapshot?.feeds
  const recurringSnap = data?.snapshot?.recurring
  const showFeeds = (feedSnap?.problem_total || 0) > 0
  const showRecurring = (recurringSnap?.stalled_total || 0) > 0

  // Whether the middle column has anything to show. Every box in it self-hides
  // when empty, so on a quiet morning the column would render as a blank track
  // in the middle of the grid — the lopsided "empty space" the owner flagged.
  // When it's empty we drop the column entirely and the grid narrows to
  // Today + comms, so there is never a hole (see the grid).
  const showMiddle = requestItems.length > 0 || moneyItems.length > 0 || showFeeds || showRecurring

  // How many tracks the grid actually has children for. The template used to
  // be keyed on `showMiddle` ALONE, which was right only for office roles:
  // Column C is gated on `canComms`, so a viewer with work on the board got a
  // three-track template holding two children (a blank third column), and a
  // viewer on a quiet morning got two tracks holding one. Both are the empty
  // space the owner has complained about, and both were invisible to the
  // existing role test, which checked that the rail was gone but never looked
  // at the template it left behind.
  const columns = 1 + (showMiddle ? 1 : 0) + (canComms ? 1 : 0)

  // The single most pressing thing for the focus headline. When nothing is
  // pressing there is NO headline: the hero slot stays empty and the greeting
  // line carries the section on its own. A 26px "You're on top of it this
  // morning." spent the largest type on the page saying nothing actionable —
  // the quiet morning is already legible from a board with no rows on it.
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
    return { tone: 'calm' }
  }, [needsCleanerItems, data])

  const systemsSection = byKey.systems
  const safeSection = byKey.safe_to_ignore
  // The quiet collapsed lines at the bottom, in order, skipping the empty ones.
  // Derived once because both the row's track count and its contents need it.
  const tailNotices = [systemsSection, safeSection].filter(sec => sec && sec.items.length > 0)

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

        {/* ONE command row: identity · tabs · Ask/Refresh.
            This was two stacked rows — an identity header, then SubNav on its
            own line — which spent ~64px of the top of the page on chrome before
            the hero. At shell: they share a line, the tabs taking the slack;
            below 900px it wraps to exactly the two rows it had before — name
            and actions together, tabs underneath — because seven tabs plus two
            buttons do not fit on a phone, and a naive flex-col would have made
            it THREE rows and pushed Ask/Refresh below the tabs, spending more
            of the smallest screen on chrome rather than less.

            The company name carries the page's `<h1>`. It is 13px and the focus
            headline is 26px, but heading level is structure, not size: this line
            is always present and the focus headline is not, so putting the `<h1>`
            on the conditional one made the document outline depend on how busy
            the morning was — and after the calm verdict was retired, a quiet
            morning had no `<h1>` at all. FocusBar's is an `<h2>`. */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="order-1 min-w-0 shrink truncate text-[13px] font-semibold tracking-tight text-ink-2">
            {data?.company || 'Ops Board'}
          </h1>
          {/* Last on a phone (its own full-width row), middle at shell: where it
              takes the slack between the name and the actions. */}
          <div className="order-3 min-w-0 w-full shell:order-2 shell:w-auto shell:flex-1">
            <SubNav />
          </div>
          <div className="order-2 ml-auto flex shrink-0 items-center gap-2 shell:order-3">
            {/* lg:, not sm:. This line is ~145px of the least urgent text on
                the page, and from sm: it was taking that out of the row the
                tabs share: at the owner's ~940px the nav was left 117px for
                184px of tabs, so "Assistant" was cut mid-word and "Owner" was
                off-screen entirely — inside an `overflow-x:auto` with no
                scrollbar and no fade, which is invisible rather than hidden.
                Navigation outranks a timestamp; it comes back at 1024px where
                there is room for both. */}
            {data?.refreshed_at && (
              <span className="hidden text-[11px] text-ink-3 lg:inline">refreshed {fmtRefreshed(data.refreshed_at)}</span>
            )}
            <button
              onClick={() => setAssistantOpen(true)}
              className="bb-focus inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2">
              <Sparkles className="h-3.5 w-3.5" /> Ask
            </button>
            <button
              onClick={() => load(true)}
              disabled={refreshing || loading}
              className="bb-focus inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          </div>
        </header>

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
            <Check className={`h-4 w-4 shrink-0 ${STATUS_ICON.ok}`} /> <span className="min-w-0 flex-1 truncate">{note}</span>
            <button onClick={() => setNote('')} className="text-ink-3 hover:text-ink" aria-label="Dismiss">✕</button>
          </div>
        )}

        {loading ? <BoardGridSkeleton /> : (
          <>
            {/* 3 — THREE-COLUMN GRID. Per-column flex stacks so a short box packs
                onto the next instead of height-locking to the tallest in its row
                (owner: "too much empty spaces"). The middle column collapses out
                entirely when there is no incoming work, no money and nothing
                broken, so the grid is never left with a blank track (owner:
                Home "looks empty/awkward"). */}
            <div data-testid="home-grid"
              className={`mt-4 grid grid-cols-1 items-start gap-4 sm:grid-cols-2 bb-board-in ${GRID_COLS[columns]}`}>

              {/* Column A — Today + needs-a-cleaner. Spans both tracks at the
                  2-col (sm) size whenever there is no middle column, so Today
                  never sits beside an empty cell. */}
              <div className={`flex flex-col gap-4 ${showMiddle ? '' : 'sm:col-span-2 shell:col-span-1'}`}>
                <HomeToday navigate={navigate} />
                {/* The jobs with nobody on them, as the JOBS — not as the
                    integer "3 jobs still need a cleaner" that used to sit here.
                    Each row names the house and the day and links to the job,
                    where it gets opened to the crew. The office never assigns
                    (brightbase-marketplace): there is no action on the row that
                    puts a person on a job. Capped at 3 — the focus bar already
                    carries the count, and the rest is the schedule's job. */}
                {byKey.needs_cleaner && (
                  <Section section={byKey.needs_cleaner} items={needsCleanerItems}
                    clearedSet={cleared} onToggle={toggleCleared}
                    onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                    setConfirmingKey={setConfirmingKey}
                    headerLink={{ label: 'Open to crew', to: '/schedule?view=dispatch' }}
                    navigate={navigate} onClearAll={clearAllInSection} clearingSection={clearingSection}
                    filtersActive={false} maxRows={3} />
                )}
              </div>

              {/* Column B — incoming work, money, and anything broken. These are
                  the SAME rows the board payload already builds, with the
                  actions it already ships (`Draft quote`, `Book it`,
                  `Mark paid`) — the two count boxes that used to stand here
                  collapsed all of it into integers you then had to go find.
                  Dropped entirely when there's nothing in it (every box
                  self-hides) so the grid narrows rather than showing a blank
                  middle track. */}
              {showMiddle && (
                /* `row-span-2` at the two-track size is what lets the comms
                   rail sit UNDER column A instead of in a band below both.
                   Column A runs short (Today + three needs-a-cleaner rows) and
                   this one runs long (requests + money), so row 1 was as tall
                   as this column and column A ended with ~370px of nothing
                   beneath it — the single largest piece of dead space left on
                   the board. Spanning both rows lets this column keep flowing
                   down the right track while the rail continues the left one.
                   Back to one row at xl:, where there are three tracks and
                   every column is its own. */
                <div className={`flex flex-col gap-4 ${
                  /* Only when there IS a rail to tuck under column A. Without
                     one this column would span an implicit second row that
                     nothing fills, buying a 16px gap for nothing. */
                  canComms ? 'sm:row-span-2 xl:row-span-1' : ''}`}>
                  {byKey.requests && (
                    <Section section={byKey.requests} items={requestItems}
                      clearedSet={cleared} onToggle={toggleCleared}
                      onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                      setConfirmingKey={setConfirmingKey}
                      headerLink={{ label: 'Open Flow', to: '/flow' }}
                      navigate={navigate} onClearAll={clearAllInSection} clearingSection={clearingSection}
                      filtersActive={false} maxRows={4} />
                  )}
                  {byKey.money && (
                    <Section section={byKey.money} items={moneyItems}
                      clearedSet={cleared} onToggle={toggleCleared}
                      onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                      setConfirmingKey={setConfirmingKey}
                      headerLink={{ label: 'Billing', to: '/billing' }}
                      navigate={navigate} onClearAll={clearAllInSection} clearingSection={clearingSection}
                      filtersActive={false} maxRows={4} />
                  )}
                  {showFeeds && <FeedHealth snap={feedSnap} />}
                  {showRecurring && <RecurringHealth snap={recurringSnap} />}
                </div>
              )}

              {/* Column C — the comms rail. Office-only: both /api/crew/threads
                  and /api/comms/* are admin/manager, so the whole rail is hidden
                  for roles that would 403. Spans both tracks at the mid (2-col)
                  width, its own track at shell:. */}
              {canComms && (
                /* Its own track only once there IS a third track (xl:, see
                   GRID_COLS). Below that it CONTINUES COLUMN A: no span, so it
                   auto-places into the left track's second row, directly under
                   the needs-a-cleaner box, while the middle column flows past
                   it on the right (that column carries the `row-span-2`). The
                   two short comms boxes are what fills the space column A used
                   to run out of. When there is no middle column it is the only
                   sibling and spans the pair, as before. */
                <div data-testid="home-comms-rail"
                  className={`flex flex-col gap-4 ${
                    showMiddle ? '' : 'sm:col-span-2 shell:col-span-1'}`}>
                  <CrewBox navigate={navigate} />
                  <ClientsBox items={messageItems} cleared={cleared} onAction={runAction}
                    actioningKey={actioningKey} confirmingKey={confirmingKey} navigate={navigate} />
                </div>
              )}
            </div>

            {/* 4 — BELOW THE GRID (demoted, nothing lost)

                PAIRED, not stacked. These were five full-width bands one after
                another, so the demoted half of the page was as tall as the half
                that matters and everything below the fold needed scrolling past
                rather than glancing at. At shell: they sit two-up; below 900px
                they stack in the same order as before.

                The stagger also ran out of order — 60 / 90 / 80 / 100ms meant
                Systems animated BEFORE the widgets sitting above it. Delays now
                follow document order. */}

            {/* Row 1 — do something (create flows) beside something's wrong
                (plumbing + inbox noise, one collapsed line each). Both halves
                are conditional, so the track count follows them for the same
                reason the main grid's does: a fixed two-up holding one child is
                the blank column this slice set out to remove, and a spacer div
                to push the survivor rightward is worse than no column. */}
            {(canComms || tailNotices.length > 0) && (
              <div data-testid="home-tail-row"
                className={`mt-4 grid grid-cols-1 items-start gap-4 bb-board-in ${
                  canComms && tailNotices.length > 0 ? 'shell:grid-cols-2' : 'shell:grid-cols-1'
                }`}
                style={{ animationDelay: '60ms' }}>
                {/* Office-only: every create flow is a write. `wide` is the
                    same condition the track count above is built from — it
                    tells the panel whether it got the whole row or half of it,
                    which decides how many tiles fit across. CSS can't infer
                    it: shell: means ~640px here and ~296px there. */}
                {canComms && <QuickActions navigate={navigate} wide={tailNotices.length === 0} />}
                {tailNotices.length > 0 && (
                  <div className="flex flex-col gap-4">
                    {tailNotices.map(section => (
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
              </div>
            )}

            {/* Row 2 — your own space (Notes + Ask Nova, drag the grip / arrow
                keys, saved on this device) beside the bench: who's asking for
                work + the week's round-up. Both bench boxes fetch themselves,
                so both wait until scrolled to (WhenVisible). Neither approves
                here — the office says yes on the marketplace page itself
                (brightbase-marketplace guard). */}
            <div data-testid="home-bento"
              className="mt-4 grid grid-cols-1 items-start gap-4 shell:grid-cols-2 bb-board-in"
              style={{ animationDelay: '90ms' }}>
              <HomeWidgets items={[
                { key: 'notes', label: 'Notes', node: <StickyNotes /> },
                canComms && { key: 'nova', label: 'Ask Nova', node: <NovaChat navigate={navigate} /> },
              ].filter(Boolean)} />
              <div className="flex flex-col gap-4">
                <WhenVisible minHeight="12rem">
                  <MarketplaceBoard />
                </WhenVisible>
                <WhenVisible minHeight="12rem">
                  <BenchDigest />
                </WhenVisible>
              </div>
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
