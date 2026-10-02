/**
 * Ops Board — the /dashboard home.
 *
 * ABOVE THE FOLD IS A BUDGET (Oct 2026 declutter). At ~940px the first paint is
 * exactly three things: a trimmed KPI strip, the REAL Schedule calendar, and
 * the Messages box (overdue replies — the #1 office surface). Everything else
 * packs below without a long scroll.
 *
 * THIS PASS CUT THE DUPLICATION, NOT THE COLOR. Home had become a second copy
 * of a page that now exists on its own: the new Flow page (/flow) is the
 * lead→cash pipeline — New requests → Quote out → Ready to book → Booked →
 * To send → Unpaid, each row with its next action. So Home's feed sections that
 * listed the SAME records — "Requests & quotes", "Needs a cleaner", "Money" —
 * were redundant with Flow. Each is now a SHORT summary card (the top line +
 * the count) that links OUT to the surface that owns the full list (Flow for
 * incoming work and coverage, Billing for money) instead of repeating every
 * row. That single change removed most of the scroll.
 *
 * WHAT STAYED A LIST. Messages: the office answers texts/emails from here, so
 * it keeps a tight capped list with inline Resolve/Reply (runAction) + Inbox →.
 * Systems and Safe-to-Ignore stay on the board but collapsed to one quiet line
 * each (plumbing + inbox noise — present, never front and centre). Notes and
 * Ask Nova dropped to the smallest, last zone so they stop dominating.
 *
 * ONE FETCH, PLUS WHAT SCROLLS INTO VIEW. `GET /api/dashboard/board` drives the
 * strip, the Messages list AND the summary counts (derived client-side from the
 * section item lists it already ships — no new field, no new request). The
 * backend ships render-ready strings, so this file is a pure view (see
 * backend/services/board_service.py). The calendar runs its own
 * useScheduleData(month) fetch. The self-fetching boxes below the fold are
 * wrapped in <WhenVisible> so their requests happen when scrolled to. Don't add
 * an eager fetch here.
 *
 * Cleared-state persists in localStorage. `/` opens search; severity filters
 * and the cleared-progress meter live behind the Filters disclosure, scoped to
 * the Messages list (the only full list left on the page).
 *
 * Design: built entirely on the app's semantic tokens (bg / panel / ink /
 * hairline + the indigo accent), so it re-skins with the active theme and
 * lands the dark iOS look under `theme-console`. Sections are flat panels with
 * a header and hairline-divided rows; color is reserved for status, never
 * decoration — no filled pills, tinted resting banners, or count bubbles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, RotateCcw, Eye, EyeOff, Check, ArrowRight, RefreshCw, Loader2, Sparkles,
  SlidersHorizontal, ChevronDown,
} from 'lucide-react'
import { get, post } from '../api'
import { pushToast } from '../utils/toastBus'
import { ErrorState } from '../components/ui'
import { TAG_TONE, SEV_DOT, SEV_LABEL, STAT_TONE, INT_DOT, SEV_ORDER } from '../components/board/tokens'
import BoardAssistant from '../components/board/BoardAssistant'
import HomeScheduleCalendar from '../components/board/HomeScheduleCalendar'
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

function matchesQuery(it, q) {
  if (!q) return true
  const hay = `${it.title} ${it.body || ''} ${(it.tags || []).map(t => t.label).join(' ')}`.toLowerCase()
  return hay.includes(q)
}

/* ── Top stats band ───────────────────────────────────────────────────────── */
// Trim to the handful that actually moves the needle (owner: "smaller boxes...
// it's almost a little redundant"). The board ships six tiles; two were low
// signal next to the rest of Home — "This weekend" repeats what the calendar
// right below already shows at a glance, and "People waiting" repeats the
// unread-messages comms count AND the Messages box directly beneath it. We keep
// the four that nothing else on first paint answers.
const STAT_KEEP = new Set(['unassigned', 'overdue', 'leads', 'collected'])

/** ONE compact, quiet KPI row at the very top of Home. Comms counts (from the
 *  shared summary poll — no extra request) lead since they're the most
 *  time-sensitive, then the board's trimmed stat tiles. "Crew chats" only
 *  appears when there's actually one waiting (it read "0" most of the time —
 *  pure noise). Comms entries are admin+manager only (those pages 403 for other
 *  roles); the stat tiles stay visible to everyone. */
function TopBand({ stats, unreadConversations, crewUnreadThreads, showComms, navigate }) {
  const commsEntries = showComms ? [
    { key: 'unread', n: unreadConversations, label: 'unread messages', to: '/comms' },
    // Only when it's non-zero — a "crew chats: 0" tile was dead weight.
    ...(crewUnreadThreads > 0
      ? [{ key: 'crew', n: crewUnreadThreads, label: 'crew chats', to: '/comms?view=crew' }]
      : []),
  ] : []
  const tiles = (stats || []).filter(s => STAT_KEEP.has(s.key))
  if (!commsEntries.length && !tiles.length) return null
  return (
    <div className="mt-4 flex items-stretch divide-x divide-hairline overflow-x-auto rounded-xl border border-hairline bg-panel">
      {commsEntries.map(e => (
        <button key={e.key} onClick={() => navigate(e.to)}
          className="flex min-w-[8.5rem] shrink-0 flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2 shell:min-w-0 shell:flex-1">
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
          className="flex min-w-[8.5rem] shrink-0 flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2 shell:min-w-0 shell:flex-1">
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

// Quiet dot + word — the old bold-uppercase pill ("TURNO", "UNASSIGNED")
// read as shouting and the owner vetoed the bubbles. The dot carries the
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

// Plumbing + inbox noise fold to one quiet line each by default. Systems
// (integration health, duplicate-client nudges) and Safe-to-Ignore (marketing
// email, delivery-failure notices) are useful but never front-and-centre — Home
// read as "so busy... full of spam" when they rendered expanded. Reviewing the
// individual rows is one tap away; nothing is deleted automatically.
const COLLAPSED_BY_DEFAULT = new Set(['systems', 'safe_to_ignore'])

// Only Safe-to-Ignore has a server-side bulk clear (the Gmail-triage
// delete-all endpoint). Systems rows are integration-health items the triage
// endpoint doesn't own, so no "Clear all" is offered there — it would silently
// miss them.
const BULK_CLEARABLE = new Set(['safe_to_ignore'])

// The collapsed one-liner reads as what the section IS, not a generic count.
function collapsedHeading(key, n) {
  if (key === 'safe_to_ignore') return `${n} item${n === 1 ? '' : 's'} you can ignore`
  if (key === 'systems') return `${n} system notice${n === 1 ? '' : 's'}`
  return `${n} item${n === 1 ? '' : 's'}`
}

function Section({ section, items, clearedSet, onToggle, onAction, actioningKey, confirmingKey, setConfirmingKey, headerLink, navigate, onClearAll, clearingSection, filtersActive, maxRows }) {
  const [open, setOpen] = useState(() => !COLLAPSED_BY_DEFAULT.has(section.key))
  if (!items.length) return null
  const collapsible = COLLAPSED_BY_DEFAULT.has(section.key)
  // Cap how many rows render before folding the rest behind "View all" — a
  // section like Needs You Today can genuinely hold a dozen-plus cards, and
  // showing every one turned Home into a very long scroll (owner: "not have
  // to scroll so much"). Filtering/search still searches the FULL set
  // (`items` already reflects the active filter), only the render is capped.
  const visibleItems = maxRows ? items.slice(0, maxRows) : items
  const hiddenCount = items.length - visibleItems.length
  // Codex review (PR #720): search/severity/hide-cleared narrow `items` to a
  // subset, but the bulk endpoint clears the WHOLE section server-side — so
  // "Clear all" while filtered would silently delete cards never shown. Only
  // offer the bulk action with nothing narrowing the view; per-row Delete
  // still works on whatever IS visible.
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
        {/* Plain number, not a count bubble (owner veto). */}
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
              confirmingClear ? 'text-amber-700 dark:text-amber-400' : 'text-indigo-600 hover:text-indigo-700 dark:text-indigo-400'
            }`}>
            {clearingSection === section.key ? 'Clearing…' : confirmingClear ? 'Confirm?' : 'Clear all'}
          </button>
        )}
        {headerLink && (
          <button onClick={() => navigate(headerLink.to)}
            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
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

// A section that now lives on its own page (Flow / Billing) collapses to this:
// the top line + the count, linking OUT instead of repeating every row. Home
// used to re-list "Requests & quotes", "Needs a cleaner" and "Money" in full —
// the same records the Flow pipeline already owns — which was most of the
// scroll. The count and preview are derived from the section's item list the
// board payload already ships (no new field, no new fetch). Renders nothing
// when the section is empty (no all-clear furniture).
function SummaryCard({ meta, items, navigate }) {
  if (!items.length) return null
  const [top, ...rest] = items
  const go = () => navigate(meta.link.to)
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-hairline bg-panel transition-colors hover:border-hairline-2">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none" aria-hidden="true">{meta.icon}</span>
        <h2 className="text-[11px] font-medium text-ink-3">{meta.title}</h2>
        {/* Plain number, not a count bubble (owner veto). */}
        <span className="ml-auto text-[11px] font-semibold tabular-nums text-ink-3">{items.length}</span>
      </header>
      <button onClick={go}
        className="flex flex-1 flex-col items-start gap-1 px-3.5 py-3 text-left transition-colors hover:bg-bg-2">
        <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-ink">{top.title}</p>
        {top.body && <p className="line-clamp-1 text-[11.5px] leading-snug text-ink-2">{top.body}</p>}
        {rest.length > 0 && <p className="text-[11px] text-ink-3">+{rest.length} more</p>}
      </button>
      <footer className="flex border-t border-hairline px-3.5 py-2">
        <button onClick={go}
          className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
          {meta.link.label}<ArrowRight className="h-3 w-3" />
        </button>
      </footer>
    </section>
  )
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

// Home is a command-center bento, not a vertical stack of full-width bands
// (owner: "worst dashboard layout ever... wasted space... useful boxes, more
// actions"). `today_schedule` is deliberately absent: today's visits render in
// the real Schedule calendar (HomeScheduleCalendar.jsx), not a second text list.
//
// Three groups of sections now, by how they render:
//   - messages → stays a tight capped LIST above the fold (the office answers
//     from here; inline Resolve/Reply);
//   - requests / needs_cleaner / money → SUMMARY CARDS that link to the page
//     that owns the full list (Flow / Billing), because that page now exists
//     and re-listing every row here was the duplication;
//   - systems / safe_to_ignore → one quiet COLLAPSED line each, below the fold.
const SUMMARY_SECTIONS = ['requests', 'needs_cleaner', 'money']

// Each summary card's header + the surface it hands off to. Requests/quotes and
// coverage gaps both live on the Flow pipeline now; money lives on Billing.
const SUMMARY_META = {
  requests: { icon: '📋', title: 'Requests & quotes', link: { label: 'Open Flow', to: '/flow' } },
  needs_cleaner: { icon: '🧹', title: 'Needs a cleaner', link: { label: 'Open Flow', to: '/flow' } },
  money: { icon: '💵', title: 'Money', link: { label: 'Billing', to: '/billing' } },
}

const SECTION_LINKS = {
  messages: { label: 'Inbox', to: '/comms' },
}
// The Messages list caps tight before folding the rest behind "+N more → Inbox"
// — it's a glance at what's overdue, not the whole inbox (owner: "not have to
// scroll so much").
const MESSAGE_CAP = 4

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
  // Triage machinery (search / severity filter / cleared progress) folds away
  // behind one quiet disclosure — the owner: "this is so busy".
  const [toolsOpen, setToolsOpen] = useState(false)
  // Messages/crew unread for the Communication strip (same summary poll the
  // sidebar uses; getCached dedupes the request).
  const { unreadConversations, crewUnreadThreads } = useUnreadCount()
  const canComms = ['admin', 'manager'].includes(currentRole())
  const [note, setNote] = useState('')
  const [actioningKey, setActioningKey] = useState(null)
  const [confirmingKey, setConfirmingKey] = useState(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [clearingSection, setClearingSection] = useState(null)
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
      if (e.key === '/' && !typing) {
        e.preventDefault()
        // Search lives inside the collapsed tools row — open it first.
        setToolsOpen(true)
        setTimeout(() => searchRef.current?.focus(), 0)
      }
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
  // An api action whose response carries an `href` also navigates there
  // afterwards, so a one-tap action that PRODUCES a record (Draft quote →
  // the new draft) lands her on it instead of leaving her on the board
  // hunting for what it made. Additive: responses without an href behave
  // exactly as before.
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
        // Delete of a triaged email: if it cleared the board but couldn't be
        // removed from Gmail (e.g. an account needs to reconnect), say why
        // instead of a bare "Deleted".
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

  // Bulk-clears one collapsed section (Safe to Ignore) in place — same
  // endpoint the Ask panel's "Clear the noise" already used, now reachable
  // right where the pile actually sits instead of a separate surface.
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

  // The Messages section is the only full LIST left on Home, so the triage
  // machinery (search / severity filter / cleared progress) is scoped to it.
  const messageItems = useMemo(() => byKey.messages?.items || [], [byKey])

  const counts = useMemo(() => {
    const c = { all: 0, urgent: 0, watch: 0, info: 0, good: 0, recurring: 0 }
    for (const it of messageItems) { c.all += 1; c[it.severity] = (c[it.severity] || 0) + 1 }
    return c
  }, [messageItems])

  const total = messageItems.length
  const clearedCount = useMemo(
    () => messageItems.reduce((n, it) => n + (cleared.has(it.id) ? 1 : 0), 0),
    [messageItems, cleared],
  )

  const q = query.trim().toLowerCase()
  const filtersActive = filter !== 'all' || !!q || hideCleared
  const visibleMessages = useMemo(() => messageItems.filter(it => {
    if (filter !== 'all' && it.severity !== filter) return false
    if (hideCleared && cleared.has(it.id)) return false
    if (q && !matchesQuery(it, q)) return false
    return true
  }), [messageItems, filter, hideCleared, cleared, q])

  // The three sections that Flow / Billing now own in full. Rendered as summary
  // cards, not row lists — the cut that removed most of the scroll. Counts and
  // previews come straight off the board payload's own item lists.
  const summaryData = useMemo(
    () => SUMMARY_SECTIONS.map(key => ({ key, items: byKey[key]?.items || [] }))
      .filter(s => s.items.length > 0),
    [byKey],
  )

  // Plumbing + noise: present on the board, one quiet collapsed line each.
  const systemsSection = byKey.systems
  const safeSection = byKey.safe_to_ignore

  // The whole-board caught-up check — nothing waiting anywhere.
  const anyAttention =
    messageItems.length > 0 ||
    summaryData.length > 0 ||
    (systemsSection?.items.length || 0) > 0 ||
    (safeSection?.items.length || 0) > 0

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

        {/* Home · Assistant · Owner. Lives here under the page title, matching
            where every other section's tab strip sits. */}
        <div className="mt-3">
          <SubNav />
        </div>

        {/* Compact KPI strip up top — the old "Communication" strip and the
            stat-tile band, merged into one dense row right under the brief
            (owner: "smaller boxes... it's almost a little redundant"). Comms/
            crew counts inside it are hidden for viewers — /comms, /requests and
            crew chat are admin/manager-only, so they'd only link into 403s. */}
        {!loading && (
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

        {loading ? (
          /* Skeleton mirrors the above-the-fold split: a tall schedule panel
             beside a short stack of feed cards. */
          <div className="mt-4 grid grid-cols-1 gap-4 shell:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <div className="h-[26rem] animate-pulse rounded-2xl border border-hairline bg-panel" />
            <div className="flex flex-col gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-40 animate-pulse rounded-2xl border border-hairline bg-panel" />
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* ── Above the fold: the schedule beside the Messages box ───────
                At ~940px first paint is the trimmed KPI strip (above), the REAL
                Schedule calendar (drag-to-reschedule and all), and Messages —
                the three things the owner looks at first. The pipeline sections
                moved to summary cards below; what's left beside the calendar is
                the one list she answers from. Collapses to one column below the
                shell: breakpoint. */}
            <div data-testid="home-abovefold"
              className="mt-4 grid grid-cols-1 gap-4 shell:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] bb-board-in">
              {/* Rendered regardless of the feed: an empty inbox must never hide
                  the week's work. */}
              <div data-testid="home-calendar-slot">
                <HomeScheduleCalendar navigate={navigate} />
              </div>

              <div className="flex flex-col gap-4">
                {messageItems.length > 0 ? (
                  <>
                    {/* Triage machinery (search / severity / cleared progress),
                        scoped to the Messages list, folded behind one quiet
                        disclosure so it reads calm (owner: "this is so busy").
                        `/` opens it. */}
                    <div className="flex items-center gap-2.5">
                      <span className="text-[11px] tabular-nums text-ink-3">{clearedCount} of {total} cleared</span>
                      <button
                        onClick={() => setToolsOpen(v => !v)}
                        aria-expanded={toolsOpen}
                        className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 hover:bg-bg-2">
                        <SlidersHorizontal className="h-3 w-3" />
                        Filters
                        {filtersActive && <span className="h-1.5 w-1.5 rounded-full bg-indigo-600" aria-hidden="true" />}
                        <ChevronDown className={`h-3 w-3 transition-transform ${toolsOpen ? 'rotate-180' : ''}`} />
                      </button>
                    </div>

                    {toolsOpen && (
                      <div className="space-y-2.5 rounded-xl border border-hairline bg-panel p-3">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                          <input
                            ref={searchRef}
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Search messages…  (press /)"
                            className="w-full rounded-lg border border-hairline bg-bg py-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-3 focus:border-indigo-500 focus:outline-hidden" />
                        </div>
                        {/* Zero-count severities are noise ("Good 0") — only offered while active. */}
                        <div className="flex flex-wrap gap-1.5">
                          {SEV_ORDER.filter(sev => sev === 'all' || (counts[sev] || 0) > 0 || filter === sev).map(sev => (
                            <FilterChip key={sev} sev={sev} count={counts[sev] || 0}
                              active={filter === sev} onClick={() => setFilter(sev)} />
                          ))}
                        </div>
                        <div className="flex items-center gap-3">
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
                      </div>
                    )}

                    {visibleMessages.length > 0 ? (
                      <Section section={byKey.messages} items={visibleMessages}
                        clearedSet={cleared} onToggle={toggleCleared}
                        onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                        headerLink={SECTION_LINKS.messages} navigate={navigate}
                        onClearAll={clearAllInSection} clearingSection={clearingSection}
                        setConfirmingKey={setConfirmingKey} filtersActive={filtersActive}
                        maxRows={MESSAGE_CAP} />
                    ) : (
                      <div className="rounded-2xl border border-hairline bg-panel px-3.5 py-6 text-center">
                        <p className="text-[13px] font-semibold text-ink">No matches</p>
                        <p className="mt-0.5 text-[11.5px] text-ink-3">Try a different search or filter.</p>
                      </div>
                    )}
                  </>
                ) : anyAttention ? (
                  /* Inbox is clear but other work waits below — a single quiet
                     line, not a full all-clear panel (owner veto on furniture). */
                  <div className="flex items-center gap-2.5 rounded-2xl border border-hairline bg-panel px-3.5 py-3">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">No messages waiting.</span>
                    <button onClick={() => navigate('/comms')}
                      className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
                      Inbox<ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5 rounded-2xl border border-hairline bg-panel px-3.5 py-4">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-ink">You're all caught up</p>
                      <p className="text-[11.5px] text-ink-3">Nothing needs your attention right now.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── The pipeline, below the fold ───────────────────────────────
                Requests & quotes, coverage gaps and money each used to re-list
                every row here. Those records now live on the Flow pipeline
                (/flow) and Billing — so Home shows just the top line + the count
                and hands off, instead of being a second copy of a page that
                exists. This is the cut that killed the scroll. Empty sections
                render nothing. */}
            {summaryData.length > 0 && (
              <div data-testid="home-summaries"
                className="mt-4 grid grid-cols-1 items-start gap-4 shell:grid-cols-3 bb-board-in"
                style={{ animationDelay: '40ms' }}>
                {summaryData.map(({ key, items }) => (
                  <SummaryCard key={key} meta={SUMMARY_META[key]} items={items} navigate={navigate} />
                ))}
              </div>
            )}

            {/* Quick actions — kept; the fastest way to start the things she
                starts most. Office-only (every create flow is a write). */}
            {canComms && (
              <div className="mt-4 bb-board-in" style={{ animationDelay: '60ms' }}>
                <QuickActions navigate={navigate} />
              </div>
            )}

            {/* Systems + Safe to Ignore — present but one quiet collapsed line
                each; plumbing and inbox noise, never front and centre. */}
            {((systemsSection?.items.length || 0) > 0 || (safeSection?.items.length || 0) > 0) && (
              <div className="mt-4 flex flex-col gap-4 bb-board-in" style={{ animationDelay: '80ms' }}>
                {[systemsSection, safeSection].filter(s => s && s.items.length > 0).map(section => (
                  <Section key={section.key} section={section} items={section.items}
                    clearedSet={cleared} onToggle={toggleCleared}
                    onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                    navigate={navigate}
                    onClearAll={clearAllInSection} clearingSection={clearingSection}
                    setConfirmingKey={setConfirmingKey} filtersActive={filtersActive}
                    maxRows={6} />
                ))}
              </div>
            )}

            {/* ── The bench ──────────────────────────────────────────────────
                Who's asking for work and the week's round-up. Both fetch
                themselves, so both wait until scrolled to (WhenVisible). Neither
                approves here — the office says yes on the marketplace page
                itself (brightbase-marketplace guard). */}
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

            {/* Notes + Ask Nova — the smallest, last zone. They used to take a
                full section up high; now they're secondary, below everything
                operational, still draggable to taste. Office-only Nova falls out
                for a viewer, so the zone quietly shrinks. */}
            <div className="mt-4 bb-board-in" style={{ animationDelay: '120ms' }}>
              <WhenVisible minHeight="14rem">
              <HomeWidgets items={[
                { key: 'notes', label: 'Notes', node: <StickyNotes /> },
                canComms && { key: 'nova', label: 'Ask Nova', node: <NovaChat navigate={navigate} /> },
              ].filter(Boolean)} />
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

        {/* Provenance footnote — mirrors the artifact's honesty about data sources. */}
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
