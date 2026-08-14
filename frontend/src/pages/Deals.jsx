/**
 * Deals — the unified deal board. One dense, sortable record table for the
 * whole lifecycle, replacing the split between the Requests inbox and the
 * Pipeline kanban. Reads /api/deals (see useDeals): un-triaged leads sit in an
 * "Inbox" stage ahead of the five opportunity stages, so the continuum
 * inbox → new → qualified → quoted → won / lost reads top to bottom.
 *
 * Chosen as a table, not cards: at volume a scannable grid beats a kanban you
 * have to drag across. Twenty-CRM idiom — flat surface, hairline rows, calm
 * ink, one indigo accent, status carried by a small colored dot, amounts in
 * tabular-nums. Inline triage lives on the row: an inbox lead gets a "Qualify"
 * action (mints its Opportunity — the visible bridge), a deal gets an inline
 * stage mover.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LayoutGrid, RefreshCw, Search, ArrowUp, ArrowDown, ArrowRight, Rocket } from 'lucide-react'
import PageHero from '../components/ui/PageHero'
import { useDeals } from '../hooks/useDeals'
import LaunchStepper from '../components/launch/LaunchStepper'

// The continuum, inbox-first. `inbox` is the derived lead phase; the rest are
// real Opportunity stages a deal can be moved between.
const STAGES = [
  { key: 'inbox',     label: 'Inbox',     dot: 'bg-ink-3' },
  { key: 'new',       label: 'New',       dot: 'bg-amber-400' },
  { key: 'qualified', label: 'Qualified', dot: 'bg-blue-400' },
  { key: 'quoted',    label: 'Quoted',    dot: 'bg-purple-400' },
  { key: 'won',       label: 'Won',       dot: 'bg-emerald-400' },
  { key: 'lost',      label: 'Lost',      dot: 'bg-red-400' },
]
const STAGE_MAP = Object.fromEntries(STAGES.map((s, i) => [s.key, { ...s, order: i }]))
const MOVE_STAGES = STAGES.filter(s => s.key !== 'inbox')  // an inbox lead is triaged, not "moved"

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
  const { deals, loading, error, busyId, reload, moveStage, triageLead } = useDeals()
  const [stageFilter, setStageFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'stage', dir: 'asc' })
  // The deal card currently open in the Launch stepper (null = closed).
  const [launching, setLaunching] = useState(null)

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

  return (
    <div className="max-w-[1600px] mx-auto">
      <div className="px-4 sm:px-8 pt-4">
        <PageHero
          title="Deals"
          subtitle={`${rows.length}${rows.length !== deals.length ? ` of ${deals.length}` : ''} in the pipeline`}
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
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search deals…"
                className="bg-bg-2 border border-hairline rounded-lg pl-8 pr-3 py-2 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-indigo-400 w-40 sm:w-52" />
            </div>
          </div>
        </PageHero>
      </div>

      <div className="px-4 sm:px-8 pb-6">
        {/* Stage filter chips — the "columns" as filters, each with a live count. */}
        <div className="flex items-center gap-1.5 flex-wrap py-3 overflow-x-auto">
          {chips.map(c => (
            <button key={c.key} onClick={() => setStageFilter(c.key)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium border transition-colors whitespace-nowrap ${
                stageFilter === c.key
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-panel border-hairline text-ink-2 hover:bg-bg-2'}`}>
              {c.key !== 'all' && <span className={`w-1.5 h-1.5 rounded-full ${STAGE_MAP[c.key]?.dot}`} />}
              {c.label}
              <span className={`tabular-nums ${stageFilter === c.key ? 'text-white/80' : 'text-ink-3'}`}>{c.n}</span>
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-3 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/25 rounded-lg px-3 py-2">{error}</div>
        )}

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
                        {d.quote_status
                          ? <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-bg-2 text-ink-2 border border-hairline capitalize">{String(d.quote_status).replace(/_/g, ' ')}</span>
                          : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="bb-td">
                        {d.job_state
                          ? <span className={`text-[12px] font-medium capitalize ${JOB_STATE_TONE[d.job_state] || 'text-ink-2'}`}>{d.job_state}</span>
                          : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="bb-td text-ink-3 tabular-nums">{ageLabel(d.age_days)}</td>
                      <td className="bb-td text-right">
                        {d.kind === 'lead' ? (
                          <button onClick={() => triageLead(d)} disabled={busyId === d.id}
                            className="inline-flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white">
                            Qualify <ArrowRight className="w-3 h-3" />
                          </button>
                        ) : (
                          <div className="inline-flex items-center gap-1.5">
                            <select value={d.stage} onChange={e => moveStage(d, e.target.value)} disabled={busyId === d.id}
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
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
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
