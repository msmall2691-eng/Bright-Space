/**
 * Ops Board — the iOS-style triage dashboard (the new /dashboard home).
 *
 * Everything that needs the operator's attention, grouped into six clearable
 * sections with one merged stat/comms band, integration-status chips,
 * per-severity filter chips, and `/`-to-search. One fetch
 * (`GET /api/dashboard/board`) drives all of that; the backend ships
 * render-ready strings, so this file is a pure view (see
 * backend/services/board_service.py). Primary sections cap at
 * PRIMARY_ROW_CAP rows on-screen, with a "+N more" link into the page that
 * owns the full set — the board is a triage surface, not a scroll-forever
 * list.
 *
 * Upcoming visits are NOT one of those sections: they render as a Week/Month
 * calendar grid across the top (components/board/ScheduleCalendar.jsx), which
 * fetches itself from /api/schedule/week.
 *
 * The four snapshot boxes below it (components/board/SnapshotBoxes.jsx) read
 * `data.snapshot` out of the SAME board response — money/hours today, crew
 * today, turnover-feed health, stalled recurring series — so the whole
 * dashboard is still one request plus the calendar's own range fetch.
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
  SlidersHorizontal, ChevronDown,
} from 'lucide-react'
import { get, post } from '../api'
import { pushToast } from '../utils/toastBus'
import { ErrorState } from '../components/ui'
import { TAG_TONE, SEV_DOT, SEV_LABEL, STAT_TONE, INT_DOT, SEV_ORDER } from '../components/board/tokens'
import BoardAssistant from '../components/board/BoardAssistant'
import ScheduleCalendar from '../components/board/ScheduleCalendar'
import AgentHelp from '../components/board/AgentHelp'
import { MoneyToday, CrewToday, FeedHealth, RecurringHealth } from '../components/board/SnapshotBoxes'
import { MoneyTrend, LeadFunnel } from '../components/board/Charts'
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

function fmtBriefTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch { return '' }
}

/* ── Daily brief strip ────────────────────────────────────────────────────── */
/** Quiet one-paragraph AI morning brief. Self-contained on purpose: it does
 *  its own fetch (once, on mount — the backend caches the prose per business
 *  day, so this is cheap) and on ANY failure renders nothing at all. The
 *  board's real data must never sit behind, or visually blame, a nicety. */
function DailyBrief() {
  const [brief, setBrief] = useState(null)     // { brief, generated_at }
  const [state, setState] = useState('loading') // loading | ready | hidden
  const [refreshing, setRefreshing] = useState(false)

  const fetchBrief = useCallback(async (refresh) => {
    try {
      const res = await get(`/api/ai/daily-brief${refresh ? '?refresh=1' : ''}`)
      if (res?.brief) { setBrief(res); setState('ready') } else { setState('hidden') }
    } catch {
      setState('hidden')
    }
  }, [])

  useEffect(() => { fetchBrief(false) }, [fetchBrief])

  if (state === 'hidden') return null
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-hairline bg-panel px-4 py-3">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" />
      {state === 'loading' ? (
        <div className="h-3.5 w-full max-w-xl animate-pulse self-center rounded bg-bg-2" />
      ) : (
        <>
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">{brief.brief}</p>
          <div className="flex shrink-0 items-center gap-2 pt-px">
            <span className="text-[11px] tabular-nums text-ink-3">{fmtBriefTime(brief.generated_at)}</span>
            <button
              onClick={async () => { setRefreshing(true); await fetchBrief(true); setRefreshing(false) }}
              disabled={refreshing}
              aria-label="Refresh brief"
              title="Regenerate today's brief"
              className="text-ink-3 transition-colors hover:text-ink disabled:opacity-50">
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/* ── Autopilot approval queue ─────────────────────────────────────────────── */

/** "2m ago" / "3h ago" for a proposal's created_at. The backend stamps naive
 *  UTC (isoformat without a zone), so assume UTC when no offset is present. */
function relTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
    const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
    if (s < 60) return 'just now'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch { return '' }
}

function ProposalRow({ p, busy, error, onApprove, onDismiss }) {
  const agent = p.agent_id ? p.agent_id.charAt(0).toUpperCase() + p.agent_id.slice(1) : 'Autopilot'
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3.5 py-3">
      <div className="min-w-0 flex-1 basis-full sm:basis-0">
        <p className="text-[11px] text-ink-3">
          {agent} proposes{p.created_at && <span className="tabular-nums"> · {relTime(p.created_at)}</span>}
        </p>
        <p className="mt-0.5 text-[13px] font-semibold leading-snug text-ink">{p.title}</p>
        {p.detail && <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{p.detail}</p>}
        {error && (
          <p className="mt-1 text-[12px] font-medium text-rose-600 dark:text-rose-400">Failed: {error}</p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 pt-0.5">
        {error ? (
          /* Execution failed — the human should read the error, not retry
             blindly. The row stays; the primary is replaced by a dead label. */
          <span className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-rose-600 opacity-60 dark:text-rose-400">
            Failed
          </span>
        ) : (
          <>
            <button onClick={() => onDismiss(p)} disabled={!!busy}
              className="inline-flex h-8 items-center rounded-md border border-hairline-2 bg-panel px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
              Dismiss
            </button>
            <button onClick={() => onApprove(p)} disabled={!!busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60">
              {busy === 'approve' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Approve
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** "Waiting for your approval" — pending ProposedActions from the Autopilot
 *  approval gate (Mia's propose-mode picks). Self-contained like DailyBrief:
 *  its own fetch, and on any failure or unexpected shape it renders nothing —
 *  the board's real data must never sit behind, or visually blame, this. */
function ProposalsQueue() {
  const [proposals, setProposals] = useState([])
  const [busy, setBusy] = useState(null)        // { id, action: 'approve'|'dismiss' }
  const [failures, setFailures] = useState({})  // id -> result.error from a failed execution

  const load = useCallback(async () => {
    try {
      const res = await get('/api/ai/proposals?status=pending')
      if (Array.isArray(res)) setProposals(res)
    } catch { /* quiet — render nothing rather than an error state */ }
  }, [])

  useEffect(() => { load() }, [load])

  const approve = useCallback(async (p) => {
    setBusy({ id: p.id, action: 'approve' })
    try {
      const res = await post(`/api/ai/proposals/${p.id}/approve`)
      if (res?.status === 'executed') {
        pushToast(`Approved — ${p.title}`, 'success')
        setProposals(prev => prev.filter(x => x.id !== p.id))
        load()
      } else {
        // status 'failed': keep the row visible with the error. No refetch —
        // the proposal is no longer pending server-side and would vanish.
        setFailures(prev => ({ ...prev, [p.id]: res?.result?.error || 'The action could not be completed.' }))
      }
    } catch (e) {
      if (e?.status === 409) { pushToast('Already decided', 'info'); load() }
      else pushToast(e?.message || 'Approve failed — nothing was changed.', 'error')
    } finally {
      setBusy(null)
    }
  }, [load])

  const dismiss = useCallback(async (p) => {
    setBusy({ id: p.id, action: 'dismiss' })
    try {
      await post(`/api/ai/proposals/${p.id}/dismiss`)
      pushToast('Proposal dismissed', 'info')
      setProposals(prev => prev.filter(x => x.id !== p.id))
      load()
    } catch (e) {
      if (e?.status === 409) { pushToast('Already decided', 'info'); load() }
      else pushToast(e?.message || 'Dismiss failed — nothing was changed.', 'error')
    } finally {
      setBusy(null)
    }
  }, [load])

  if (!proposals.length) return null
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
        <h2 className="text-[11px] font-medium text-ink-3">Waiting for your approval</h2>
        {/* Plain number, not a count bubble (owner veto). */}
        <span className="ml-auto text-[11px] font-semibold tabular-nums text-ink-3">
          {proposals.length}
        </span>
      </header>
      <div className="divide-y divide-hairline">
        {proposals.map(p => (
          <ProposalRow key={p.id} p={p}
            busy={busy?.id === p.id ? busy.action : null}
            error={failures[p.id]}
            onApprove={approve} onDismiss={dismiss} />
        ))}
      </div>
    </section>
  )
}

/* ── Top stats band ───────────────────────────────────────────────────────── */
/** ONE compact, quiet KPI row at the very top of Home. Used to be two
 *  separate bordered boxes — a "Communication" strip up here, and a second
 *  stat-tile band lower down the page (StatBand) whose "People waiting" and
 *  "New leads" tiles duplicated numbers the top strip already showed. The
 *  owner: "smaller boxes... it's almost a little redundant." Now it's one
 *  band, once, right under the header where it's seen without scrolling —
 *  client-side comms counts (unread messages, crew chats — from the shared
 *  summary poll) first since they're the most time-sensitive, then the
 *  board's own stat tiles. Comms/crew entries are admin+manager only (those
 *  pages 403 for other roles); the rest of the stats stay visible to
 *  everyone, matching the old StatBand's role-agnostic behavior. */
function TopBand({ stats, unreadConversations, crewUnreadThreads, showComms, navigate }) {
  const commsEntries = showComms ? [
    { key: 'unread', n: unreadConversations, label: 'unread messages', to: '/comms' },
    { key: 'crew', n: crewUnreadThreads, label: 'crew chats', to: '/comms?view=crew' },
  ] : []
  if (!commsEntries.length && !stats?.length) return null
  return (
    <div className="mt-4 flex items-stretch divide-x divide-hairline overflow-x-auto rounded-xl border border-hairline bg-panel">
      {commsEntries.map(e => (
        <button key={e.key} onClick={() => navigate(e.to)}
          className="flex min-w-0 flex-1 shrink-0 flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2">
          <span className="flex items-center gap-1.5">
            {e.n > 0 && <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />}
            <span className={`text-[15px] font-bold leading-none tabular-nums ${e.n > 0 ? 'text-ink' : 'text-ink-3'}`}>
              {e.n}
            </span>
          </span>
          <span className="whitespace-nowrap text-[10.5px] text-ink-3">{e.label}</span>
        </button>
      ))}
      {(stats || []).map(stat => (
        <button key={stat.key}
          onClick={() => stat.href && navigate(stat.href)}
          title={stat.sub || undefined}
          className="flex min-w-0 flex-1 shrink-0 flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2">
          <span className={`text-[15px] font-bold leading-none tabular-nums ${STAT_TONE[stat.tone] || STAT_TONE.neutral}`}>
            {stat.value}
          </span>
          <span className="whitespace-nowrap text-[10.5px] text-ink-3">{stat.label}</span>
        </button>
      ))}
    </div>
  )
}

/* ── Crew activity ────────────────────────────────────────────────────────── */
/** Staff activity, right under communication: the latest crew↔office chatter
 *  from /api/crew/threads (who said what, unread as dot + number), linking
 *  into the Messages page's Crew view. Self-contained like DailyBrief — its
 *  own fetch, renders nothing on failure/emptiness (viewers 403 here, and a
 *  quiet page beats an error card for a nicety). */
function CrewActivity({ navigate }) {
  const [threads, setThreads] = useState(null)
  useEffect(() => {
    get('/api/crew/threads')
      .then(t => setThreads(Array.isArray(t) ? t : []))
      .catch(() => setThreads([]))
  }, [])
  const recent = (threads || []).filter(t => t.last_message).slice(0, 4)
  if (recent.length === 0) return null
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none">👷</span>
        <h2 className="text-[11px] font-medium text-ink-3">Crew</h2>
        <button onClick={() => navigate('/comms?view=crew')}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
          Open crew chat<ArrowRight className="h-3 w-3" />
        </button>
      </header>
      <div className="divide-y divide-hairline">
        {recent.map(t => (
          <button key={t.user_id} onClick={() => navigate('/comms?view=crew')}
            className="flex w-full items-baseline gap-2 px-3.5 py-2 text-left transition-colors hover:bg-bg-2">
            <span className={`shrink-0 text-[12.5px] ${t.unread > 0 ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`}>
              {t.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
              {t.last_message.sender === 'office' && 'You: '}{t.last_message.body}
            </span>
            {t.unread > 0 && (
              <span className="flex shrink-0 items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-600" aria-hidden="true" />
                <span className="text-[10px] font-bold tabular-nums text-ink">{t.unread}</span>
              </span>
            )}
            <span className="shrink-0 text-[10.5px] tabular-nums text-ink-3">{relTime(t.last_activity)}</span>
          </button>
        ))}
      </div>
    </section>
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

// Owner report: the inbox-triage pile (marketing email, delivery-failure
// notices — literally named "Safe to Ignore" by the backend) rendered fully
// expanded by default, so Home read as "so busy... full of spam." The bulk
// "Clear the noise" action already existed but only inside the separate Ask
// panel, disconnected from the pile it clears. This section now collapses to
// one quiet line by default with the clear action right there — reviewing
// individual items is still one tap away, nothing is deleted automatically.
const COLLAPSED_BY_DEFAULT = new Set(['safe_to_ignore'])

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
  const canClearAll = collapsible && !filtersActive
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
              {items.length} item{items.length === 1 ? '' : 's'} you can ignore
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

/* ── Page ─────────────────────────────────────────────────────────────────── */

// The owner's stated priority for Home, top to bottom: communication, staff
// activity, schedule, then KPIs — so sections render in that order regardless
// of payload order, split around the compact KPI band. Money/systems/noise
// follow below the fold.
// `today_schedule` is deliberately absent: today's visits now render as the
// Week/Month calendar grid (components/board/ScheduleCalendar.jsx) rather than
// a second text list of the same jobs — the owner asked to "immediately have
// eyes on the cal schedule", and carrying both was exactly the redundancy she
// flagged. The backend no longer emits that section either.
// One subject per widget, in the order she named them: who's waiting on a
// reply, what work is coming in, whether the crew is covered, then money and
// plumbing. The old mixed sections (Needs You Today = jobs + replies + quote
// nudges; Real People Waiting = conversations + leads) are gone — that
// grouping was the "chaos", not the styling.
const SECTION_RANK = { messages: 0, requests: 1, needs_cleaner: 2, money: 3, systems: 4, safe_to_ignore: 5 }
const PRIMARY_SECTIONS = new Set(['messages', 'requests', 'needs_cleaner'])
const SECTION_LINKS = {
  messages: { label: 'Inbox', to: '/comms' },
  requests: { label: 'Requests', to: '/requests' },
  needs_cleaner: { label: 'Dispatch', to: '/schedule?view=dispatch' },
  money: { label: 'Billing', to: '/billing' },
}
// Every primary section shows at most this many rows on Home before folding
// the rest behind its header "View all" link — the owner: "not have to
// scroll so much... it's almost a little redundant." Secondary sections
// (money/systems/ignore-pile) are already short and stay uncapped.
const PRIMARY_ROW_CAP = 5

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
  // Never undefined: each box guards its own slice, and a box whose slice
  // failed server-side simply doesn't render (see build_snapshot).
  const snapshot = data?.snapshot || {}
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
    const ordered = [...sections].sort(
      (a, b) => (SECTION_RANK[a.key] ?? 99) - (SECTION_RANK[b.key] ?? 99))
    return ordered.map(s => ({
      section: s,
      items: s.items.filter(it => {
        if (filter !== 'all' && it.severity !== filter) return false
        if (hideCleared && cleared.has(it.id)) return false
        if (q && !matchesQuery(it, q)) return false
        return true
      }),
    }))
  }, [sections, filter, hideCleared, cleared, q])

  // Communication + schedule sections above the KPI band; money/systems/noise
  // below it — the owner's linear order for Home.
  const primarySections = visibleBySection.filter(v => PRIMARY_SECTIONS.has(v.section.key))
  const secondarySections = visibleBySection.filter(v => !PRIMARY_SECTIONS.has(v.section.key))

  const anyVisible = visibleBySection.some(v => v.items.length > 0)
  const filtersActive = filter !== 'all' || !!q || hideCleared

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

        <DailyBrief />

        {note && (
          /* Quiet hairline card + emerald check — not a tinted banner. */
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-hairline bg-panel px-3 py-2 text-[12px] font-medium text-ink-2">
            <Check className="h-4 w-4 shrink-0 text-emerald-500" /> <span className="min-w-0 flex-1 truncate">{note}</span>
            <button onClick={() => setNote('')} className="text-ink-3 hover:text-ink" aria-label="Dismiss">✕</button>
          </div>
        )}

        {/* 1 — Every number at a glance, right under the header: the old
            "Communication" strip and the KPI band merged into one row.
            Comms/crew counts inside it are hidden for viewers — /comms,
            /requests and crew chat are admin/manager-only, so they could
            only link into 403s. */}
        {!loading && (
          <TopBand stats={data?.stats}
            unreadConversations={unreadConversations}
            crewUnreadThreads={crewUnreadThreads}
            showComms={canComms}
            navigate={navigate} />
        )}

        {/* The attention header + triage machinery, folded behind one quiet
            disclosure. Everything below it is one widget grid. */}
        <div className="mt-6 flex items-center gap-2.5">
          <h2 className="text-[11px] font-medium text-ink-3">Needs attention</h2>
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
          <div className="mt-2 space-y-2.5 rounded-xl border border-hairline bg-panel p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search everything…  (press /)"
                className="w-full rounded-lg border border-hairline bg-bg py-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-3 focus:border-indigo-500 focus:outline-none" />
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

        {/* ── The widget grid ────────────────────────────────────────────
            Owner: "I would love more condensed like widgets on a dashboard."
            One real CSS grid (not the old CSS-columns masonry, which
            reordered cards unpredictably as content changed). Each concern
            is its own bounded box; the schedule — the one she called "a big
            one" — spans two columns from the shell: breakpoint up. Cards are
            `items-start` so each keeps its natural height instead of
            stretching to the tallest in its row. */}
        <div className="mt-3 flex flex-col gap-4">
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-56 animate-pulse rounded-2xl border border-hairline bg-panel" />
            ))
          ) : (
            <>
              {/* Schedule leads and spans the FULL width of the grid — the
                  owner asked for the calendar across the top rather than
                  sharing a row, and a month grid squeezed into two of three
                  columns loses the thing that makes it useful (seeing the
                  shape of the week/month at a glance). Rendered outside the
                  `anyVisible` gate: an empty attention board must never hide
                  the week's work. */}
              <div data-testid="home-calendar-slot">
                <ScheduleCalendar navigate={navigate} />
              </div>

              {/* TWO COLUMNS THAT PACK, not a grid.
                  Home used a CSS grid, which ties every card in a row to the
                  height of the tallest one — a four-number "Today" box beside
                  a five-row "Recurring" box left a card's worth of dead space
                  under the short one (owner: "too much empty spaces lol").
                  Each column is its own flex stack, so cards sit directly on
                  top of each other and a tall card only pushes down its OWN
                  column.

                  Columns are assigned by subject, not round-robin: money with
                  money, work with work. Round-robin looks tidy until a box
                  hides itself and everything after it hops columns. */}
              <div className="grid grid-cols-1 gap-4 shell:grid-cols-2">
                <div className="flex flex-col gap-4">
                  <MoneyToday snap={snapshot.money_today} />
                  <MoneyTrend snap={snapshot.money_trend} />
                  <LeadFunnel snap={snapshot.lead_funnel} />
                  <AgentHelp navigate={navigate} />
                  {secondarySections.map(({ section, items }) => (
                    <Section key={section.key} section={section} items={items}
                      clearedSet={cleared} onToggle={toggleCleared}
                      onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                      headerLink={SECTION_LINKS[section.key]} navigate={navigate}
                      onClearAll={clearAllInSection} clearingSection={clearingSection}
                      setConfirmingKey={setConfirmingKey} filtersActive={filtersActive}
                      maxRows={PRIMARY_ROW_CAP} />
                  ))}
                </div>

                <div className="flex flex-col gap-4">
                  <CrewToday snap={snapshot.crew} />
                  {canComms && <CrewActivity navigate={navigate} />}
                  <ProposalsQueue />
                  {primarySections.map(({ section, items }) => (
                    <Section key={section.key} section={section} items={items}
                      clearedSet={cleared} onToggle={toggleCleared}
                      onAction={runAction} actioningKey={actioningKey} confirmingKey={confirmingKey}
                      headerLink={SECTION_LINKS[section.key]} navigate={navigate}
                      onClearAll={clearAllInSection} clearingSection={clearingSection}
                      setConfirmingKey={setConfirmingKey} filtersActive={filtersActive}
                      maxRows={PRIMARY_ROW_CAP} />
                  ))}
                  <FeedHealth snap={snapshot.feeds} />
                  <RecurringHealth snap={snapshot.recurring} />
                </div>
              </div>
            </>
          )}
        </div>

        {!loading && !anyVisible && (
          <>
            <div className="mt-12 flex flex-col items-center justify-center text-center">
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
          Check-offs are saved on this device. Twilio balance and Square deposits aren't live yet.
        </p>

        <BoardAssistant open={assistantOpen} onClose={() => setAssistantOpen(false)}
          sections={sections} navigate={navigate} onActed={() => load(true)} />
      </div>
    </div>
  )
}
