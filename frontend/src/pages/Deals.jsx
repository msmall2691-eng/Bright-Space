/**
 * Deals — the unified deal board. One page for the whole opportunity
 * lifecycle, with a Table/Board toggle (?view=table | ?view=board) instead of
 * two separate destinations (the old Deals page + the old Pipeline kanban at
 * /pipeline — merged here in the Aug-2026 nav-simplification pass; see
 * nav/routes.js for the retired route note).
 *
 * Table: a dense, sortable record grid for the whole continuum
 * inbox → new → qualified → quoted → won / lost, top to bottom. Un-triaged
 * leads sit in an "Inbox" stage ahead of the five opportunity stages (see
 * useDeals). Inline triage lives on the row: an inbox lead gets a "Qualify"
 * action (mints its Opportunity — the visible bridge), a deal gets an inline
 * stage mover.
 *
 * Board: the same deals (opportunity stages only — an un-triaged lead has no
 * board column) as a drag-and-drop kanban, for anyone who prefers moving
 * cards by hand over the row select.
 *
 * Both views share one fetch (useDeals → /api/deals), one header, one search
 * box, and one SavedViewsBar — the point of the merge.
 */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  LayoutGrid, RefreshCw, Search, ArrowUp, ArrowDown, ArrowRight, Rocket,
  Trash2, Columns3, Rows3, GripVertical, DollarSign, Calendar,
} from 'lucide-react'
import { del } from '../api'
import { confirmDialog } from '../utils/confirmBus'
import PageHero from '../components/ui/PageHero'
import SubNav from '../components/ui/SubNav'
import StatusBadge from '../components/ui/StatusBadge'
import SavedViewsBar from '../components/SavedViewsBar'
import { useDeals } from '../hooks/useDeals'
import LaunchStepper from '../components/launch/LaunchStepper'
import { QUOTE_STATUS_VARIANT } from '../components/quoting/constants'

// The continuum, inbox-first. `inbox` is the derived lead phase; the rest are
// real Opportunity stages a deal can be moved between. `accent` is the
// board column's top border (kanban only); `dot` is used everywhere.
const STAGES = [
  { key: 'inbox',     label: 'Inbox',     dot: 'bg-ink-3',                                       },
  { key: 'new',       label: 'New',       dot: 'bg-amber-400',   accent: 'border-amber-400'      },
  { key: 'qualified', label: 'Qualified', dot: 'bg-blue-400',    accent: 'border-blue-400'       },
  { key: 'quoted',    label: 'Quoted',    dot: 'bg-purple-400',  accent: 'border-purple-400'     },
  { key: 'won',       label: 'Won',       dot: 'bg-emerald-400', accent: 'border-emerald-400'    },
  { key: 'lost',      label: 'Lost',      dot: 'bg-red-400',     accent: 'border-red-400'        },
]
const STAGE_MAP = Object.fromEntries(STAGES.map((s, i) => [s.key, { ...s, order: i }]))
const MOVE_STAGES = STAGES.filter(s => s.key !== 'inbox')  // an inbox lead is triaged, not "moved"
const BOARD_STAGES = STAGES.filter(s => s.key !== 'inbox')  // the kanban has no inbox column

const money = (n) => (n || n === 0)
  ? `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'

const ageLabel = (d) => {
  if (d == null) return ''
  if (d <= 0) return 'today'
  if (d < 7) return `${d}d`
  if (d < 60) return `${Math.floor(d / 7)}w`
  return `${Math.floor(d / 30)}mo`
}

const JOB_STATE_TONE = {
  scheduled: 'text-blue-600 dark:text-blue-300',
  dispatched: 'text-violet-600 dark:text-violet-300',
  done: 'text-emerald-600 dark:text-emerald-300',
}

function StageDot({ stage }) {
  const s = STAGE_MAP[stage] || STAGE_MAP.new
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`w-2 h-2 rounded-full ${s.dot}`} />
      <span className="text-[12px] text-ink-2">{s.label}</span>
    </span>
  )
}

function SortHead({ label, col, sort, onSort, className = '' }) {
  const active = sort.key === col
  return (
    <th className={`bb-th text-left select-none ${className}`}>
      <button onClick={() => onSort(col)} className="inline-flex min-h-0 items-center gap-1 text-[11px] font-medium hover:text-ink-2">
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </th>
  )
}

export default function Deals() {
  const { deals, loading, error, busyId, reload, moveStage, triageLead, setError } = useDeals()
  const [searchParams, setSearchParams] = useSearchParams()
  // Table vs Board — linkable/bookmarkable via ?view=, defaulting to table
  // (the destination that used to live in the sidebar).
  const view = searchParams.get('view') === 'board' ? 'board' : 'table'
  const setView = (next) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'table') params.delete('view')
    else params.set('view', next)
    setSearchParams(params, { replace: true })
  }

  const [stageFilter, setStageFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'stage', dir: 'asc' })
  // The deal card currently open in the Launch stepper (null = closed).
  const [launching, setLaunching] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  // Board-only controls (ported from the old Pipeline page). Lost deals are
  // the board's "archived" bucket — hidden by default so dead deals don't
  // clutter it; a toggle brings the column back.
  const [owner, setOwner] = useState('')
  const [showLost, setShowLost] = useState(false)

  // Snapshot persisted by saved views, and the reverse — apply a view's
  // config. Same shape the old Pipeline page used, so existing saved views
  // for this entity keep working.
  const viewConfig = { search, owner }
  const applyView = (cfg) => { setSearch(cfg.search ?? ''); setOwner(cfg.owner ?? '') }

  // Both row kinds hard-delete on the backend: an inbox lead via
  // DELETE /api/intake/{id} (the inquiry itself is erased), a deal via
  // DELETE /api/opportunities/{id} (the deal record goes; quotes, jobs, and
  // invoices created from it are kept). Confirmed through the global dialog.
  const removeDeal = async (d) => {
    const isLead = d.kind === 'lead'
    const ok = await confirmDialog(
      isLead
        ? 'Permanently delete this request? The original inquiry — message, contact details, and estimate — is erased and cannot be recovered.'
        : 'Permanently delete this deal? Its record and stage history are erased and cannot be recovered.\n\nThe client and any quotes, jobs, or invoices created from it are kept.',
      { title: isLead ? 'Delete request?' : 'Delete deal?', confirmLabel: 'Delete permanently', danger: true }
    )
    if (!ok) return
    setDeletingId(d.id)
    try {
      await del(isLead ? `/api/intake/${d.lead_id}` : `/api/opportunities/${d.opportunity_id}`)
      await reload()
    } catch (e) {
      setError(e?.message || 'Could not delete — nothing was changed.')
    } finally {
      setDeletingId(null)
    }
  }

  const onSort = (key) =>
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })

  const counts = useMemo(() => {
    const c = {}
    for (const d of deals) c[d.stage] = (c[d.stage] || 0) + 1
    return c
  }, [deals])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = deals.filter(d => {
      const okStage = stageFilter === 'all' || d.stage === stageFilter
      const okSearch = !q || (d.title || '').toLowerCase().includes(q) || (d.client_name || '').toLowerCase().includes(q)
      return okStage && okSearch
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    const key = sort.key
    list = [...list].sort((a, b) => {
      let av, bv
      if (key === 'stage') { av = STAGE_MAP[a.stage]?.order ?? 99; bv = STAGE_MAP[b.stage]?.order ?? 99 }
      else if (key === 'amount') { av = a.amount || 0; bv = b.amount || 0 }
      else if (key === 'age') { av = a.age_days ?? -1; bv = b.age_days ?? -1 }
      else { av = (a[key] || '').toString().toLowerCase(); bv = (b[key] || '').toString().toLowerCase() }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
    return list
  }, [deals, stageFilter, search, sort])

  const chips = [{ key: 'all', label: 'All', n: deals.length }, ...STAGES.map(s => ({ key: s.key, label: s.label, n: counts[s.key] || 0 }))]

  // ── Board data (deal cards only — an inbox lead has no board column) ──
  const [dragId, setDragId] = useState(null)
  const [overStage, setOverStage] = useState(null)

  const owners = useMemo(
    () => [...new Set(deals.filter(d => d.kind === 'deal').map(d => d.owner).filter(Boolean))].sort(),
    [deals]
  )
  const boardVisible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return deals.filter(d => {
      if (d.kind !== 'deal') return false
      const okSearch = !q || (d.title || '').toLowerCase().includes(q) || (d.client_name || '').toLowerCase().includes(q)
      const okLost = showLost || d.stage !== 'lost'
      return okSearch && okLost && (!owner || d.owner === owner)
    })
  }, [deals, search, owner, showLost])
  const boardByStage = (s) => boardVisible.filter(d => d.stage === s)
  const boardTotal = (list) => list.reduce((sum, d) => sum + (d.amount || 0), 0)

  function moveTo(stage) {
    const id = dragId
    setOverStage(null); setDragId(null)
    if (!id) return
    const card = deals.find(d => d.id === id)
    if (card) moveStage(card, stage)
  }

  const subtitle = view === 'board'
    ? `${boardVisible.length}${boardVisible.length !== deals.filter(d => d.kind === 'deal').length ? ` of ${deals.filter(d => d.kind === 'deal').length}` : ''} in play`
    : `${rows.length}${rows.length !== deals.length ? ` of ${deals.length}` : ''} in the pipeline`

  return (
    <div className="max-w-[1600px] mx-auto">
      <div className="px-4 sm:px-8 pt-4">
        <PageHero
          title="Deals"
          subtitle={subtitle}
          icon={LayoutGrid}
          pods={[
            { label: 'Inbox', value: counts.inbox || 0, tone: 'text-ink-2' },
            { label: 'Qualified', value: counts.qualified || 0, tone: 'text-blue-300' },
            { label: 'Quoted', value: counts.quoted || 0, tone: 'text-indigo-200' },
            { label: 'Won', value: counts.won || 0, tone: 'text-emerald-300' },
          ]}
          actions={
            <button onClick={reload}
              className="flex items-center gap-1.5 bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          }
        >
          <SubNav className="mb-3" />

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search deals…"
                className="bg-bg-2 border border-hairline rounded-lg pl-8 pr-3 py-2 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-indigo-400 w-40 sm:w-52" />
            </div>
            {view === 'board' && owners.length > 0 && (
              <select value={owner} onChange={e => setOwner(e.target.value)}
                className="bg-bg-2 border border-hairline rounded-lg px-3 py-2 text-[12px] text-ink-2 focus:outline-none focus:border-indigo-400">
                <option value="">All owners</option>
                {owners.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {view === 'board' && (
              <button onClick={() => setShowLost(v => !v)}
                className={`px-3 py-2 rounded-lg text-[12px] border transition-colors ${showLost ? 'bg-bg-2 text-ink-2 border-hairline' : 'bg-bg-2/50 text-ink-3 border-hairline hover:text-ink-2'}`}>
                {showLost ? 'Hide lost' : 'Show lost'}
              </button>
            )}
            <SavedViewsBar entityType="opportunity" currentConfig={viewConfig} onApply={applyView} defaultLabel="All deals" />
          </div>
        </PageHero>
      </div>

      <div className="px-4 sm:px-8 pb-6">
        {/* Stage filter chips (table) act as the "columns" as filters, each
            with a live count. The Table/Board segmented control replaces the
            old cross-links between the two former pages — same page now. */}
        <div className="flex items-center justify-between gap-2 flex-wrap py-3">
          {view === 'table' ? (
            <div className="flex items-center gap-1.5 flex-wrap overflow-x-auto">
              {chips.map(c => (
                <button key={c.key} onClick={() => setStageFilter(c.key)}
                  aria-pressed={stageFilter === c.key}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium border transition-colors whitespace-nowrap bg-panel ${
                    stageFilter === c.key
                      ? 'border-ink/30 text-ink font-semibold'
                      : 'border-hairline text-ink-2 hover:bg-bg-2'}`}>
                  {c.key !== 'all' && <span className={`w-1.5 h-1.5 rounded-full ${STAGE_MAP[c.key]?.dot}`} />}
                  {c.label}
                  <span className="tabular-nums text-ink-3">{c.n}</span>
                </button>
              ))}
            </div>
          ) : <div />}

          <div className="flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5 shrink-0">
            <button onClick={() => setView('table')} aria-pressed={view === 'table'}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                view === 'table' ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
              <Rows3 className="w-3.5 h-3.5" /> Table
            </button>
            <button onClick={() => setView('board')} aria-pressed={view === 'board'}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                view === 'board' ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
              <Columns3 className="w-3.5 h-3.5" /> Board
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-3 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/25 rounded-lg px-3 py-2">{error}</div>
        )}

        {view === 'table' ? (
          <div className="rounded-xl border border-hairline bg-panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="bb-table min-w-[820px]">
                <thead className="bg-panel">
                  <tr>
                    <SortHead label="Deal" col="client_name" sort={sort} onSort={onSort} />
                    <SortHead label="Stage" col="stage" sort={sort} onSort={onSort} />
                    <SortHead label="Amount" col="amount" sort={sort} onSort={onSort} className="text-right" />
                    <th className="bb-th">Quote</th>
                    <th className="bb-th">Work</th>
                    <SortHead label="Age" col="age" sort={sort} onSort={onSort} />
                    <th className="bb-th text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {loading ? (
                    <tr><td colSpan={7} className="px-3 py-12 text-center text-ink-3">Loading deals…</td></tr>
                  ) : rows.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-12 text-center text-ink-3">No deals here yet.</td></tr>
                  ) : rows.map(d => {
                    const to = d.kind === 'lead' ? `/requests/${d.lead_id}` : `/opportunities/${d.opportunity_id}`
                    return (
                      <tr key={d.id} className={`hover:bg-bg-2/50 transition-colors ${busyId === d.id ? 'opacity-60' : ''}`}>
                        <td className="bb-td max-w-[280px]">
                          <Link to={to} className="font-medium text-ink hover:text-indigo-600 truncate block">{d.title || 'Untitled'}</Link>
                          {d.client_name && <span className="text-[11px] text-ink-3 truncate block">{d.client_name}</span>}
                        </td>
                        <td className="bb-td"><StageDot stage={d.stage} /></td>
                        <td className="bb-td text-right tabular-nums font-semibold text-ink-2">{money(d.amount)}</td>
                        <td className="bb-td">
                          {d.quote_status ? (
                            d.quote_id ? (
                              // Record link (BrightBase convention: quiet body,
                              // indigo on hover, no underline) wrapping the
                              // existing status pill — links to the specific
                              // quote the status was computed from.
                              <Link to={`/quotes/${d.quote_id}`} className="group/rl inline-block no-underline">
                                <StatusBadge
                                  status={QUOTE_STATUS_VARIANT[d.quote_status] || 'neutral'}
                                  className="transition-colors group-hover/rl:border-indigo-300 group-hover/rl:text-indigo-600"
                                >
                                  {String(d.quote_status).replace(/_/g, ' ')}
                                </StatusBadge>
                              </Link>
                            ) : (
                              <StatusBadge status={QUOTE_STATUS_VARIANT[d.quote_status] || 'neutral'}>{String(d.quote_status).replace(/_/g, ' ')}</StatusBadge>
                            )
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="bb-td">
                          {d.job_state ? (
                            d.job_id ? (
                              <Link to={`/jobs/${d.job_id}`}
                                className={`text-[12px] font-medium capitalize no-underline hover:text-indigo-600 ${JOB_STATE_TONE[d.job_state] || 'text-ink-2'}`}>
                                {d.job_state}
                              </Link>
                            ) : (
                              <span className={`text-[12px] font-medium capitalize ${JOB_STATE_TONE[d.job_state] || 'text-ink-2'}`}>{d.job_state}</span>
                            )
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="bb-td text-ink-3 tabular-nums">{ageLabel(d.age_days)}</td>
                        <td className="bb-td text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {d.kind === 'lead' ? (
                              <button onClick={() => triageLead(d)} disabled={busyId === d.id || deletingId === d.id}
                                className="inline-flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white">
                                Qualify <ArrowRight className="w-3 h-3" />
                              </button>
                            ) : (
                              <>
                                <select value={d.stage} onChange={e => moveStage(d, e.target.value)} disabled={busyId === d.id || deletingId === d.id}
                                  aria-label="Move deal to stage"
                                  className="text-[12px] bg-bg-2 border border-hairline rounded-md px-2 py-1 text-ink-2 focus:outline-none focus:border-indigo-400">
                                  {MOVE_STAGES.map(s => (
                                    <option key={s.key} value={s.key}>{s.key === d.stage ? `● ${s.label}` : `Move to ${s.label}`}</option>
                                  ))}
                                </select>
                                {d.stage !== 'lost' && (
                                  <button onClick={() => setLaunching(d)} title="Launch this deal"
                                    className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-1 rounded-md border border-indigo-200 dark:border-indigo-500/30 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10">
                                    <Rocket className="w-3 h-3" /> Launch
                                  </button>
                                )}
                              </>
                            )}
                            {/* Quiet red icon, spaced from the primary action — a hard
                                delete on both row kinds, confirmed via the global dialog. */}
                            <button onClick={() => removeDeal(d)} disabled={busyId === d.id || deletingId === d.id}
                              title={d.kind === 'lead' ? 'Delete this request' : 'Delete this deal'}
                              aria-label={`Delete ${d.title || (d.kind === 'lead' ? 'request' : 'deal')}`}
                              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50 transition-colors">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : loading ? (
          <div className="text-sm text-ink-3 py-12 text-center">Loading deals…</div>
        ) : (
          // Stack the stages vertically on mobile (a 5-column horizontal board is
          // a 1150px scroll on a phone); horizontal board on sm+.
          <div className="flex flex-col sm:flex-row gap-3 sm:overflow-x-auto pb-4">
            {BOARD_STAGES.filter(s => showLost || s.key !== 'lost').map(stage => {
              const list = boardByStage(stage.key)
              return (
                <div
                  key={stage.key}
                  onDragOver={(e) => { e.preventDefault(); setOverStage(stage.key) }}
                  onDragLeave={() => setOverStage(s => (s === stage.key ? null : s))}
                  onDrop={() => moveTo(stage.key)}
                  className={`flex-1 sm:min-w-[230px] rounded-xl border bg-bg-2/40 transition-colors
                    ${overStage === stage.key ? 'border-indigo-400 bg-indigo-500/5' : 'border-hairline'}`}
                >
                  <div className={`flex items-center justify-between px-3 py-2 border-b-2 ${stage.accent}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${stage.dot}`} />
                      <span className="text-sm font-semibold text-ink">{stage.label}</span>
                      <span className="text-xs text-ink-3">{list.length}</span>
                    </div>
                    <span className="text-xs font-medium text-ink-2">{money(boardTotal(list))}</span>
                  </div>

                  <div className="p-2 space-y-2 min-h-[120px]">
                    {list.length === 0 && (
                      <div className="text-[11px] text-ink-3 text-center py-6 select-none">Drop deals here</div>
                    )}
                    {list.map(d => (
                      <div
                        key={d.id}
                        draggable
                        onDragStart={() => setDragId(d.id)}
                        onDragEnd={() => { setDragId(null); setOverStage(null) }}
                        className={`group bg-panel border border-hairline rounded-lg p-2.5 cursor-grab active:cursor-grabbing
                          hover:border-indigo-300 transition-colors ${busyId === d.id ? 'opacity-60' : ''}
                          ${dragId === d.id ? 'ring-1 ring-indigo-400' : ''}`}
                      >
                        <div className="flex items-start gap-1.5">
                          {/* Drag handle: desktop-only — HTML5 DnD doesn't fire on touch. */}
                          <GripVertical className="hidden sm:block w-3.5 h-3.5 text-ink-3 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                          <div className="min-w-0 flex-1">
                            <Link to={`/opportunities/${d.opportunity_id}`}
                              className="text-[13px] font-medium text-ink hover:text-indigo-600 truncate block">
                              {d.title || 'Untitled'}
                            </Link>
                            {d.client_name && (
                              <Link to={d.client_id ? `/clients/${d.client_id}` : '#'}
                                className="text-[11px] text-ink-3 hover:text-indigo-600 truncate block">
                                {d.client_name}
                              </Link>
                            )}
                            <div className="flex items-center justify-between gap-2 mt-1">
                              <span className="flex items-center gap-1 text-[11px] font-semibold text-ink-2">
                                <DollarSign className="w-3 h-3 text-ink-3" />{money(d.amount).replace(/^\$/, '')}
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {d.service_type && (
                                  <StatusBadge status="neutral">
                                    {String(d.service_type).replace(/_/g, ' ')}
                                  </StatusBadge>
                                )}
                                {d.age_days != null && (
                                  <span className="flex items-center gap-0.5 text-[10px] text-ink-3">
                                    <Calendar className="w-3 h-3" />{ageLabel(d.age_days)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                        {/* Touch-friendly stage mover (drag doesn't work on
                            phones). Hidden on sm+ where drag-and-drop is used. */}
                        <select
                          value={d.stage}
                          onChange={e => moveStage(d, e.target.value)}
                          onClick={e => e.stopPropagation()}
                          disabled={busyId === d.id}
                          className="sm:hidden mt-2 w-full text-[12px] bg-bg-2 border border-hairline rounded-md px-2 py-2 text-ink-2 focus:outline-none focus:border-indigo-400"
                          aria-label="Move deal to stage"
                        >
                          {MOVE_STAGES.map(s => (
                            <option key={s.key} value={s.key}>
                              {s.key === d.stage ? `● ${s.label}` : `Move to ${s.label}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {launching && (
        <LaunchStepper
          opportunityId={launching.opportunity_id}
          title={launching.title || launching.client_name}
          onClose={() => { setLaunching(null); reload() }}
        />
      )}
    </div>
  )
}
