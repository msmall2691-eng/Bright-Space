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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { get, post, getCached } from '../api'
import JobCreateModal from '../components/JobCreateModal'
import DuplicateReviewPanel from '../components/recurring/DuplicateReviewPanel'
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

      <div className="max-w-5xl mx-auto px-4 sm:px-8 pb-8">
        {autoGenOff && (
          <div className="mt-4 mb-4 flex items-start gap-2.5 rounded-lg bg-panel border border-hairline px-3.5 py-3 text-sm text-ink-2">
            <span className={`w-1.5 h-1.5 rounded-full ${SEV_DOT.watch} shrink-0 mt-1.5`} aria-hidden="true" />
            <div>
              <p className="font-semibold text-ink">Recurring auto-generate is off</p>
              <p className="text-[13px] mt-0.5 text-ink-3">
                Schedules were filled once and won’t roll forward, so upcoming visits will stop
                appearing over time. Turn on <b>Recurring auto-generate</b> in Settings → General
                to keep the window topped up automatically.
              </p>
              <a href="/settings#general"
                className="inline-block mt-1.5 text-[13px] font-semibold underline underline-offset-2 hover:opacity-80">
                Open Settings → General
              </a>
            </div>
          </div>
        )}
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <select
            value={filterClient}
            onChange={e => setFilterClient(e.target.value)}
            className="px-3 py-2 border border-hairline rounded-lg text-sm bg-panel"
          >
            <option value="">All clients</option>
            {clientOptions.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1 bg-panel border border-hairline rounded-lg p-0.5">
            {[
              { v: 'active', label: 'Active' },
              { v: 'paused', label: 'Paused' },
              { v: 'cancelled', label: 'Cancelled' },
              { v: 'ended', label: 'Ended' },
              { v: 'all', label: 'All' },
            ].map(o => (
              <button key={o.v}
                onClick={() => setFilterStatus(o.v)}
                aria-pressed={filterStatus === o.v}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  filterStatus === o.v ? 'bg-bg-2 text-ink shadow-xs' : 'text-ink-3 hover:text-ink'
                }`}>
                {o.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-ink-3 ml-auto">
            {filtered.length} of {schedules.length}
          </span>
        </div>

        {dupGroupCount > 0 && (
          <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 rounded-lg bg-panel border border-hairline text-ink-2 text-sm">
            <span className={`w-1.5 h-1.5 rounded-full ${SEV_DOT.watch} shrink-0`} aria-hidden="true" />
            <span className="flex-1 min-w-0">
              {dupGroupCount} possible duplicate group{dupGroupCount === 1 ? '' : 's'} — same client,
              property, cadence, and time on overlapping days. Review them side by side and pick
              which series to keep; nothing is changed automatically.
            </span>
            <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setReviewOpen(true)}>
              Review
            </Button>
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
    </>
  )
}
