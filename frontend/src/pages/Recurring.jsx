/**
 * Recurring — the root page: the series list, its toolbar, and the routing
 * between the list, a series' detail, the duplicate review and the health
 * scan.
 *
 * It used to be all of that AND those four screens AND three modals AND the
 * date helpers, in one 1795-line file. Every one of those pieces was already
 * props-only, so they now live beside this in `components/recurring/`,
 * moved verbatim.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { get, patch, post, getCached } from '../api'
import JobCreateModal from '../components/JobCreateModal'
import DuplicateReviewPanel from '../components/recurring/DuplicateReviewPanel'
import EditSeriesModal from '../components/recurring/EditSeriesModal'
import HealthPanel from '../components/recurring/HealthPanel'
import SeriesDetail from '../components/recurring/SeriesDetail'
import SeriesRow from '../components/recurring/SeriesRow'
import Button from '../components/ui/Button'
import EmptyState from '../components/ui/EmptyState'
import ErrorNote from '../components/ui/ErrorNote'
import ListSkeleton from '../components/ui/ListSkeleton'
import PageHeader from '../components/ui/PageHeader'
import SubNav from '../components/ui/SubNav'
import { confirmDialog } from '../utils/confirmBus'
import { groupDuplicateSeries, loadReviewedDupKeys, saveReviewedDupKeys, seriesState } from '../utils/recurringDuplicates'
import { toast } from '../utils/toastBus'
import { AlertTriangle, Calendar, Plus, RefreshCw, Repeat } from 'lucide-react'
import { SEV_DOT } from '../components/board/tokens'

export default function Recurring() {
  const [params, setParams] = useSearchParams()
  const seriesId = params.get('series')

  const [schedules, setSchedules] = useState([])
  const [clientsById, setClientsById] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterClient, setFilterClient] = useState('')
  // Opens on the live book of business. It used to open on 'all', so a series
  // you cancelled stayed on the screen you landed on — which is most of why
  // cancelling read as "it didn't work". Retired series are one chip away.
  const [filterStatus, setFilterStatus] = useState('active')
  const [showCreate, setShowCreate] = useState(false)

  // Surface the one setting that makes recurring "run dry": if auto-generate is
  // OFF, the schedules do a one-time fill and never roll forward. Warn loudly so
  // the operator isn't left wondering why upcoming visits stop appearing.
  const [autoGenOff, setAutoGenOff] = useState(false)
  useEffect(() => {
    get('/api/settings/automation')
      .then(s => setAutoGenOff(s?.recurring_auto_generate_enabled === false))
      .catch(() => setAutoGenOff(false)) // stay quiet if we can't tell
  }, [])

  const loadList = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [sch, cli] = await Promise.all([
        get('/api/recurring'),
        // T-06: preload up to 1000 so schedule → client-name resolution and
        // the filter dropdown cover the whole book, not just the first 50.
        getCached('/api/clients?limit=1000').catch(() => []),
      ])
      const cliArr = Array.isArray(cli) ? cli : (cli.items || [])
      const map = {}; cliArr.forEach(c => { map[c.id] = c })
      setSchedules(Array.isArray(sch) ? sch : (sch.items || []))
      setClientsById(map)
    } catch (e) {
      setError(e.message || 'Failed to load recurring schedules')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])

  const [cleaning, setCleaning] = useState(false)
  // One-time maintenance: find + remove the off-cadence duplicate visits the
  // old biweekly-drift bug created. Always previews (dry-run) and asks before
  // cancelling anything.
  const cleanupDuplicates = useCallback(async () => {
    setCleaning(true)
    try {
      const preview = await get('/api/recurring/cleanup/off-phase-preview')
      const items = preview?.candidates || []
      if (!items.length) {
        toast.success('No off-cadence duplicate visits found — your recurring schedule is clean.')
        return
      }
      const sample = items.slice(0, 6).map(c => `• ${c.scheduled_date} — ${c.title}`).join('\n')
      const more = items.length > 6 ? `\n…and ${items.length - 6} more` : ''
      const ok = await confirmDialog(
        `Found ${items.length} future visit${items.length === 1 ? '' : 's'} on the wrong week (leftovers from the old biweekly bug):\n\n${sample}${more}\n\nCancel them? Their Google Calendar events are removed too. Past and completed visits are never touched.`,
        { confirmLabel: `Cancel ${items.length} duplicate${items.length === 1 ? '' : 's'}`, cancelLabel: 'Keep them', danger: true },
      )
      if (!ok) return
      const res = await post('/api/recurring/cleanup/off-phase-apply', {})
      toast.success(`Removed ${res?.cancelled_count ?? 0} duplicate visit${res?.cancelled_count === 1 ? '' : 's'}.`)
      loadList()
    } catch (e) {
      toast.error(e.message || 'Cleanup failed')
    } finally {
      setCleaning(false)
    }
  }, [loadList])

  // JobCreateModal loads properties itself, scoped to whichever client gets
  // picked inside it — no page-level preload needed (the old RecurringCreateModal
  // required properties up front for its own picker; this modal doesn't).
  const openCreate = useCallback(() => { setCreatePrefill(null); setShowCreate(true) }, [])

  // A "do this next" handoff from elsewhere (e.g. a paid invoice → "Set up
  // recurring") opens the create modal prefilled for that client/property via
  // ?new=1&client=&property=&name=. One-shot: the params are cleared so a
  // refresh doesn't reopen it.
  const [createPrefill, setCreatePrefill] = useState(null)
  useEffect(() => {
    if (params.get('new') === '1') {
      const cid = params.get('client')
      const pid = params.get('property')
      setCreatePrefill({
        clientId: cid ? Number(cid) : undefined,
        clientName: params.get('name') || undefined,
        initialPropertyId: pid ? Number(pid) : null,
      })
      setShowCreate(true)
      setParams({}, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openSeries = (id) => setParams({ series: String(id) })
  const backToList = () => setParams({})

  // ── Inline row actions ───────────────────────────────────────────────────
  // Both drive endpoints the detail page already drives; no new backend.
  // Cancel is deliberately NOT offered here — it is the irreversible one, and
  // on a list a mis-click lands on the wrong series. It stays in the detail
  // page's danger zone behind its booked-visit dialog.
  // The set of series ids with a PATCH in flight, NOT a single id. It was one
  // id, which meant pausing a second row replaced the first row's pending
  // state: whichever request settled next cleared the guard for every row
  // still waiting, so those rows went actionable again mid-flight and could
  // be fired a second time, landing two toasts and two Undos for one action
  // (codex P2 on #1161). One request must not clear another row's guard.
  //
  // Updated functionally rather than through a ref. A ref plus a re-entry
  // check was the first version, to catch two clicks landing in one tick —
  // but React flushes discrete events like clicks synchronously, so the row
  // has already re-rendered disabled by the time a second click arrives and
  // the guard could not be reached. A mutation removing it survived every
  // test, including one written specifically to hit that window. Unreachable
  // defensive code that nothing can exercise is worse than none.
  const [pausing, setPausing] = useState(() => new Set())
  const [editing, setEditing] = useState(null)   // the series whose rule is open

  // Applies a local `active` flip so the row answers immediately. The row then
  // leaves the "Active" filter, which is the honest outcome — and the Undo in
  // the toast is what brings it back, the Requests-archive pattern.
  const setActiveLocal = useCallback((id, active) => {
    setSchedules(prev => prev.map(s => (s.id === id ? { ...s, active } : s)))
  }, [])

  const togglePause = useCallback(async (s) => {
    const next = !s.active
    setPausing(prev => new Set(prev).add(s.id))
    try {
      await patch(`/api/recurring/${s.id}`, { active: next })
      setActiveLocal(s.id, next)
      toast.success(next ? 'Series resumed' : 'Series paused', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await patch(`/api/recurring/${s.id}`, { active: !next })
              setActiveLocal(s.id, !next)
              // Deliberately does NOT reach into an open SeriesDetail. See the
              // note above the detail view below for why that was cut.
            } catch (err) {
              console.error('[Recurring] Undo pause failed:', err)
              toast.error('Could not put that series back.')
            }
          },
        },
      })
    } catch (e) {
      // No local flip happened, so the row still shows the truth. Say so,
      // rather than leaving a silent no-op that reads as a dead button.
      toast.error(e.message || (next ? 'Could not resume that series.' : 'Could not pause that series.'))
    } finally {
      setPausing(prev => { const next = new Set(prev); next.delete(s.id); return next })
    }
  }, [setActiveLocal])

  const filtered = useMemo(() => {
    return schedules.filter(s => {
      // "Active" means LIVE (active and not past its end date); an active row
      // whose series_end_date has passed — how split retires a predecessor —
      // is "Ended", its own quiet state, so retired series stop reading as
      // live. The `active` column itself is untouched (display-only).
      // One shared verdict per series (seriesState) rather than three hand-
      // rolled predicates that could disagree with the chip the row displays.
      if (filterStatus !== 'all' && seriesState(s) !== filterStatus) return false
      if (filterClient && String(s.client_id) !== String(filterClient)) return false
      return true
    })
  }, [schedules, filterClient, filterStatus])

  const clientOptions = useMemo(
    () => Object.values(clientsById).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [clientsById],
  )

  // Counts live ON the filter chips — the Properties/Clients idiom (#1041), so
  // the number appears in exactly one place and the active state is never
  // ambiguous. This replaced a separate "N of M" span, which was the same
  // fact in a second spot.
  //
  // Counted over the CLIENT-filtered set rather than every series: with a
  // client picked, whole-book counts would have the chip saying "Active 12"
  // above a list of 2. A chip that disagrees with the rows under it is worse
  // than no chip.
  const stateCounts = useMemo(() => {
    const scope = filterClient
      ? schedules.filter(s => String(s.client_id) === String(filterClient))
      : schedules
    const out = { all: scope.length, active: 0, paused: 0, cancelled: 0, ended: 0 }
    for (const s of scope) {
      const st = seriesState(s)
      if (out[st] != null) out[st] += 1
    }
    return out
  }, [schedules, filterClient])

  // Duplicate groups among LIVE series (shared definition with the backend
  // pre-create guard: same client + property + cadence + time, overlapping
  // days). Ended series never count, so retired split-predecessors stop
  // flooding the flag.
  const dupGroups = useMemo(() => groupDuplicateSeries(schedules), [schedules])
  const dupKeyBySeriesId = useMemo(() => {
    const m = new Map()
    for (const g of dupGroups) for (const s of g.members) m.set(s.id, g.key)
    return m
  }, [dupGroups])

  // Review-duplicates panel: opened from the banner; groups the flagged
  // series so the owner picks a keeper and confirms each pause/cancel.
  // "Skip this group" (false positive) persists per-group in localStorage so
  // the banner count and pills stop nagging about it.
  const [reviewOpen, setReviewOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [reviewedKeys, setReviewedKeys] = useState(() => loadReviewedDupKeys())
  const toggleReviewed = useCallback((key) => {
    setReviewedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveReviewedDupKeys(next)
      return next
    })
  }, [])
  const dupGroupCount = useMemo(
    () => dupGroups.filter(g => !reviewedKeys.has(g.key)).length,
    [dupGroups, reviewedKeys],
  )

  // Detail view
  //
  // ## It deliberately does not hear about the list's Undo
  //
  // There is a real gap here: pause a row, walk into that series, and hit the
  // still-visible Undo, and this view keeps showing the copy it fetched on
  // mount — Paused, with a Resume button, for a series the server has active
  // again. It self-corrects on the next action or revisit, because every one
  // of them reloads.
  //
  // This PR built the fix and then removed it, which is worth writing down so
  // nobody rebuilds it by accident. Closing that gap meant a `refreshToken`
  // prop, a ref read at click time, a `silent` load that skips the loading
  // flag so the skeleton doesn't eat an open modal, and a sequence guard on
  // every write. Five review rounds found a real bug in each of those in turn
  // — a reload that never fired, a remount that discarded unsaved rule edits,
  // a failed refresh that blanked the page, and finally a refresh whose
  // `.catch(() => [])` subrequests silently emptied the overrides list behind
  // an intact screen.
  //
  // Every fix was correct and every one opened the next hole, because the
  // thing being fixed is two components owning one piece of server state with
  // a toast outliving the navigation between them. That wants a shared cache
  // with invalidation, not a prop. What it does NOT want is more of what was
  // here: the machinery had grown past the cost of the transient wrong label
  // it was preventing.
  if (seriesId) {
    return (
      <>
        <SeriesDetail
          id={seriesId}
          onBack={backToList}
          onChanged={loadList}
          toast={toast}
        />
      </>
    )
  }

  // List view
  //
  // The page used to BE the stack: header, an auto-generate warning block, a
  // filter row, a duplicate banner, then the list — five full-width bands
  // before the first row, and the filters scrolling away the moment you went
  // looking through them. It is three now, and the toolbar is sticky.
  //
  // ## Why sticky rather than an internal scroll region
  //
  // The first version of this gave the list `overflow-y-auto flex-1 min-h-0`
  // under a `flex h-full` root, copied from `pages/Properties.jsx`. It does
  // not work, and Properties' does not either: `App.jsx` wraps every route in
  // `.bb-page-in`, which is an ANIMATION class with no height, so a
  // percentage `h-full` under it resolves against `height: auto` and the
  // chain never binds. Measured at 940px with 40 series — `<main>` scrolled
  // 641px and the toolbar left the screen at -408px (codex P2 on #1161).
  //
  // Six series could never have shown that, which is the lesson: the only
  // condition under which an internal scroll region differs from a page that
  // simply grows is overflow, and I had not rendered overflow.
  //
  // A definite height on `.bb-page-in` would fix both pages, but it changes
  // the layout of every route in the app and belongs nowhere near a PR about
  // one list. `position: sticky` needs no height chain at all: it pins to
  // `<main>`, which is the scrollport that was doing the scrolling anyway.
  return (
    <>
      <PageHeader
        title="Recurring bookings"
        subtitle="Weekly and biweekly cleans. Change one visit without disturbing future ones."
        icon={Repeat}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={loadList}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setHealthOpen(true)}
              title="Scan every series for duplicates, ghosts, missing times, and broken links">
              <AlertTriangle className="w-4 h-4 mr-1" /> Health check
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1" /> New series
            </Button>
          </>
        }
      >
        <SubNav />
      </PageHeader>

      {/* `max-w-5xl mx-auto` is kept from the old layout: without it the rows
          stretch the full width of a large monitor and the actions end up a
          long way from the title they belong to. */}
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-8 pb-4 sm:pb-6">
        {/* One command row: client, state filter carrying its own counts, and
            the duplicate flag folded in on the right. Wraps at phone width;
            the chip track scrolls sideways rather than squeezing.

            Sticky, with an opaque `bg-bg` so the rows pass underneath rather
            than through it. `top-0` pins it to <main>, the element that
            actually scrolls — see the note on the return above for why this
            is not an internal scroll region. */}
        <div className="sticky top-0 z-10 bg-bg flex flex-wrap items-center gap-2 pt-4 pb-3">
          <select
            value={filterClient}
            onChange={e => setFilterClient(e.target.value)}
            aria-label="Filter by client"
            className="px-3 py-2 border border-hairline rounded-lg text-sm bg-panel"
          >
            <option value="">All clients</option>
            {clientOptions.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {/* `role="group"` with `aria-pressed` buttons, NOT a tablist.
              These are filter toggles: there is no tabpanel, no
              `aria-controls`, and nothing is revealed by "selecting" one.
              Declaring `role="tab"` promises a keyboard contract — arrow-key
              navigation with a single tab stop via roving tabindex — that
              none of these implement, so a screen reader announces "tab, 1 of
              5" and the arrows do nothing (codex P2 on #1161).

              This page had it right before: `aria-pressed` on plain buttons.
              The tablist came in with the Properties/Clients visual idiom,
              and the same unfulfilled promise is in InvoicingHeader,
              PropertiesToolbar, ClientsToolbar and QuotesToolbar. Those are a
              sweep of their own, not this PR's. */}
          <div
            role="group"
            aria-label="Filter by series state"
            className="flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5 overflow-x-auto scrollbar-thin max-w-full"
          >
            {[
              { v: 'active', label: 'Active' },
              { v: 'paused', label: 'Paused' },
              { v: 'cancelled', label: 'Cancelled' },
              { v: 'ended', label: 'Ended' },
              { v: 'all', label: 'All' },
            ].map(o => {
              const active = filterStatus === o.v
              return (
                <button key={o.v} aria-pressed={active}
                  onClick={() => setFilterStatus(o.v)}
                  className={`shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    active ? 'bg-panel text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2'
                  }`}>
                  {o.label}
                  <span className="ml-1.5 text-[10px] text-ink-3 tabular-nums">{stateCounts[o.v]}</span>
                </button>
              )
            })}
          </div>

          {dupGroupCount > 0 && (
            // Was a full-width band carrying three lines of explanation. The
            // explanation belongs in the panel that does the work, so this is
            // a bare dot + word and the way in.
            // No `ml-auto` on this: at ~940px the select plus the chips already
            // fill the row, so pushing it right put it alone on a second line,
            // right-aligned under nothing. Flowing straight after the chips
            // keeps it attached to the control it belongs with at every width.
            <button
              onClick={() => setReviewOpen(true)}
              title="Same client, property, cadence, and time on overlapping days. Review them side by side and pick which to keep — nothing changes automatically."
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-2 hover:text-ink rounded-md"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${SEV_DOT.watch} shrink-0`} aria-hidden="true" />
              {dupGroupCount} possible duplicate{dupGroupCount === 1 ? '' : 's'}
              <span className="text-ink-3">· Review</span>
            </button>
          )}
        </div>

        {autoGenOff && (
          // One line, action inline. The old version spent four lines and a
          // paragraph of body copy on a setting the operator either knows
          // about or needs to toggle — the link is the useful part.
          <div className="flex items-center gap-2 mb-3 rounded-lg bg-panel border border-hairline px-3 py-2 text-[13px] text-ink-2">
            <span className={`w-1.5 h-1.5 rounded-full ${SEV_DOT.watch} shrink-0`} aria-hidden="true" />
            <span className="min-w-0">
              <b className="font-semibold text-ink">Auto-generate is off</b> — visits were filled
              once and won’t roll forward.
            </span>
            <a href="/settings#general"
              className="ml-auto shrink-0 text-[12px] font-semibold underline underline-offset-2 hover:opacity-80">
              Turn it on
            </a>
          </div>
        )}

        <ErrorNote className="mb-3">{error}</ErrorNote>

        {loading ? (
          <ListSkeleton rows={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title={schedules.length === 0 ? 'No recurring series yet' : 'Nothing matches your filters'}
            description={schedules.length === 0
              ? 'Create one here, from a client, or from a signed quote.'
              : 'Try clearing the client or status filter.'}
            action={schedules.length === 0
              ? <Button variant="primary" size="sm" onClick={openCreate}>
                  <Plus className="w-4 h-4 mr-1" />New series
                </Button>
              : null}
          />
        ) : (
          <ul className="space-y-2.5">
            {filtered.map(s => (
              <SeriesRow
                key={s.id}
                s={s}
                clientName={clientsById[s.client_id]?.name || 'Unknown client'}
                onOpen={openSeries}
                isDuplicate={dupKeyBySeriesId.has(s.id) && !reviewedKeys.has(dupKeyBySeriesId.get(s.id))}
                onTogglePause={togglePause}
                onEdit={setEditing}
                busy={pausing.has(s.id)}
              />
            ))}
          </ul>
        )}
      </div>
      {healthOpen && (
        <HealthPanel
          onClose={() => setHealthOpen(false)}
          onChanged={loadList}
          schedules={schedules}
          onOpenSeries={openSeries}
          onOpenDuplicates={() => setReviewOpen(true)}
          onCleanupOffPhase={cleanupDuplicates}
          cleaningOffPhase={cleaning}
        />
      )}
      {reviewOpen && (
        <DuplicateReviewPanel
          schedules={schedules}
          clientsById={clientsById}
          reviewedKeys={reviewedKeys}
          onToggleReviewed={toggleReviewed}
          onChanged={loadList}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {showCreate && (
        <JobCreateModal
          defaultRecurring
          clientId={createPrefill?.clientId}
          clientName={createPrefill?.clientName}
          initialPropertyId={createPrefill?.initialPropertyId ?? null}
          onClose={() => { setShowCreate(false); setCreatePrefill(null) }}
          onCreated={() => { setShowCreate(false); setCreatePrefill(null); loadList() }}
        />
      )}
      {editing && (
        // The same modal the detail page opens, on the same payload: the list
        // and detail endpoints both return sched_to_dict, so every field this
        // form pre-fills from is already in the row. Reloads the list on save
        // because the rule it edits is what the row renders.
        <EditSeriesModal
          schedule={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); loadList(); toast.success('Rule updated for future visits') }}
        />
      )}
    </>
  )
}
