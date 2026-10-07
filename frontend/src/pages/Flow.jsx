import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Workflow, Loader2, Check } from 'lucide-react'
import { get, del, post } from '../api'
import { toast } from '../utils/toastBus'
import PageTitle from '../components/ui/PageTitle'
import SubNav from '../components/ui/SubNav'
import { ErrorState, EmptyState, ListSkeleton } from '../components/ui'
import { STATUS_DOT } from '../theme/statusDots'
import { STATUS_TEXT } from '../theme/statusText'

/**
 * Flow — the lead→cash pipeline as one calm, prioritized list.
 *
 * The owner's standing complaint is that the app is "all over the place": to
 * take one lead from a request to a booked, invoiced job you bounce between
 * six screens, and nothing shows the whole line at a glance. This is that line,
 * top to bottom — New requests → Quote out → Ready to book → Booked → To send →
 * Unpaid — each row carrying the single next action. Reads like Jobber's flow,
 * stays quiet like BrightBase (dot+word, hairline cards, one accent; no pills,
 * tints, or count bubbles).
 *
 * One fetch (`/api/dashboard/pipeline`, render-ready). The page is a pure view:
 * every action is a deep link into the page that owns that step — the "Book it"
 * link lands on the quote's booking flow, which no longer dead-ends.
 */

// Stage header dot — semantic, literal strings (Tailwind JIT needs them whole).
const STAGE_DOT = {
  indigo: 'bg-indigo-500',
  amber: STATUS_DOT.attention,
  emerald: STATUS_DOT.ok,
  red: STATUS_DOT.problem,
  blue: STATUS_DOT.info,
}

// Per-row severity dot + the tone used by row tags (dot + word, never a pill).
const DOT = {
  urgent: STATUS_DOT.problem,
  watch: STATUS_DOT.attention,
  info: STATUS_DOT.info,
  good: STATUS_DOT.ok,
  recurring: 'bg-violet-500',
  // tag tones
  amber: STATUS_DOT.attention,
  emerald: STATUS_DOT.ok,
  rose: STATUS_DOT.problem,
  blue: STATUS_DOT.info,
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  gray: 'bg-ink-3',
}

function Tag({ tag }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-3">
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tag.tone] || 'bg-ink-3'}`} />
      {tag.label}
    </span>
  )
}

// The archive action, if this row has one (accepted quotes) — what makes a
// row selectable for a bulk clear.
function archiveActionOf(item) {
  return (item.actions || []).find(a => a.kind === 'api' && a.method === 'DELETE')
}

function FlowRow({ item, onAction, confirmingKey, busyKey, selectMode, selected, onToggleSelect }) {
  const actions = item.actions || []
  const primaryLink = actions.find(a => a.kind !== 'api')
  const selectable = selectMode && !!archiveActionOf(item)
  const isSel = selected?.has(item.id)
  const go = () => {
    if (selectMode) { if (selectable) onToggleSelect(item.id); return }
    if (primaryLink) onAction(item, primaryLink)   // row = shortcut to next step
  }
  const clickable = selectMode ? selectable : !!primaryLink
  return (
    <div
      onClick={go}
      className={`flex items-start gap-2.5 px-3.5 py-2.5 transition-colors ${clickable ? 'cursor-pointer hover:bg-bg-2' : ''} ${selectMode && !selectable ? 'opacity-40' : ''}`}
    >
      {selectMode ? (
        <span className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border transition-colors ${
          isSel ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-hairline-2 text-transparent'
        }`}>
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
      ) : (
        <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[item.severity] || 'bg-ink-3'}`} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-[13px] font-semibold leading-snug text-ink">{item.title}</p>
          {item.meta && (
            <span className="shrink-0 pt-px text-[10px] font-medium tabular-nums text-ink-3">{item.meta}</span>
          )}
        </div>
        {item.body && <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-ink-2">{item.body}</p>}
        {/* In select mode, keep tags for context but hide the per-row actions. */}
        {(item.tags?.length > 0 || (!selectMode && actions.length > 0)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {item.tags?.map((t, i) => <Tag key={i} tag={t} />)}
            {!selectMode && actions.length > 0 && (
              <div className="ml-auto flex items-center gap-2">
                {actions.map((a, i) => {
                  const key = `${item.id}:${a.label}`
                  if (a.kind !== 'api') {
                    return (
                      <button
                        key={i}
                        onClick={(e) => { e.stopPropagation(); onAction(item, a) }}
                        className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1"
                      >
                        {a.label}<ArrowRight className="h-3 w-3" />
                      </button>
                    )
                  }
                  const busy = busyKey === key
                  const confirming = confirmingKey === key
                  return (
                    <button
                      key={i}
                      onClick={(e) => { e.stopPropagation(); onAction(item, a) }}
                      disabled={busy}
                      className={`inline-flex items-center gap-1 text-[11px] font-semibold transition-colors disabled:opacity-60 ${
                        confirming ? STATUS_TEXT.problem : 'text-ink-3 hover:text-ink-2'
                      }`}
                    >
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

function Stage({ stage, onAction, confirmingKey, busyKey, index, selectMode, selected, onToggleSelect }) {
  return (
    <section
      className="bb-board-in overflow-hidden rounded-2xl border border-hairline bg-panel"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className={`h-1.5 w-1.5 rounded-full ${STAGE_DOT[stage.tone] || 'bg-ink-3'}`} />
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{stage.label}</h2>
        <span className="ml-auto text-[11px] font-semibold tabular-nums text-ink-3">{stage.count}</span>
      </header>
      <div className="divide-y divide-hairline">
        {stage.items.map(it => (
          <FlowRow key={it.id} item={it} onAction={onAction}
            confirmingKey={confirmingKey} busyKey={busyKey}
            selectMode={selectMode} selected={selected} onToggleSelect={onToggleSelect} />
        ))}
      </div>
    </section>
  )
}

// Drop an item from the payload, and any stage it empties — so an archived
// quote vanishes from the list in place, no refetch (one fetch per screen).
function removeItem(data, itemId) {
  if (!data) return data
  const stages = data.stages
    .map(s => ({ ...s, items: s.items.filter(it => it.id !== itemId) }))
    .map(s => ({ ...s, count: s.items.length }))
    .filter(s => s.items.length > 0)
  return { ...data, stages, total_open: stages.reduce((n, s) => n + s.count, 0) }
}

// Same, for a whole set of item ids — the in-place result of a bulk archive.
function removeMany(data, itemIds) {
  if (!data) return data
  const stages = data.stages
    .map(s => ({ ...s, items: s.items.filter(it => !itemIds.has(it.id)) }))
    .map(s => ({ ...s, count: s.items.length }))
    .filter(s => s.items.length > 0)
  return { ...data, stages, total_open: stages.reduce((n, s) => n + s.count, 0) }
}

export default function Flow() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [confirmingKey, setConfirmingKey] = useState(null)
  const [busyKey, setBusyKey] = useState(null)
  // Bulk clear: pick several stale/test quotes and archive them in one action.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkConfirming, setBulkConfirming] = useState(false)

  const load = useCallback(() => {
    setLoading(true); setError(null)
    get('/api/dashboard/pipeline')
      .then(d => setData(d))
      .catch(e => setError(e?.message || 'Could not load the pipeline'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // Link actions navigate; api actions run in place. The ones that are
  // outward-facing or destructive (Archive, Send, Mark paid) carry a `confirm`
  // and take a second tap; a safe producer (Draft a quote) has none and fires
  // on the first.
  const onAction = useCallback(async (item, action) => {
    if (action.kind !== 'api') { navigate(action.href); return }
    const key = `${item.id}:${action.label}`
    if (action.confirm && confirmingKey !== key) { setConfirmingKey(key); return }
    setConfirmingKey(null); setBusyKey(key)
    try {
      const res = await (action.method === 'DELETE'
        ? del(action.endpoint)
        : post(action.endpoint, action.body || {}))
      // An action that PRODUCES a record (Draft a quote → the new draft) comes
      // back with an href — land on it to finish, like the board does. Anything
      // that just advanced this row (archive, send, mark paid) clears it here.
      if (res && typeof res.href === 'string' && res.href.startsWith('/')) {
        navigate(res.href)
      } else {
        setData(d => removeItem(d, item.id))
        toast.success(action.done || 'Done')
      }
    } catch (e) {
      toast.error(e?.message || 'That didn’t work')
    } finally {
      setBusyKey(null)
    }
  }, [confirmingKey, navigate])

  const stages = data?.stages || []
  // Any rows that can be archived (accepted quotes) → offer bulk select.
  const anyArchivable = stages.some(s => s.items.some(archiveActionOf))

  const toggleSelect = useCallback((itemId) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(itemId) ? next.delete(itemId) : next.add(itemId)
      return next
    })
    setBulkConfirming(false)
  }, [])

  const exitSelect = useCallback(() => {
    setSelectMode(false); setSelected(new Set()); setBulkConfirming(false)
  }, [])

  const archiveSelected = useCallback(async () => {
    if (!bulkConfirming) { setBulkConfirming(true); return }
    // Map the picked rows → their quote ids (from each row's archive endpoint).
    const ids = []
    for (const s of stages) for (const it of s.items) {
      if (!selected.has(it.id)) continue
      const a = archiveActionOf(it)
      const qid = a && parseInt(String(a.endpoint).split('/').pop(), 10)
      if (qid && !Number.isNaN(qid)) ids.push(qid)
    }
    if (!ids.length) { exitSelect(); return }
    setBulkBusy(true)
    try {
      const res = await post('/api/quotes/bulk-archive', { ids })
      const picked = new Set(selected)
      setData(d => removeMany(d, picked))
      toast.success(`Archived ${res?.archived_count ?? ids.length}`)
      if (res?.skipped_count) toast.info(`${res.skipped_count} skipped — already booked`)
      exitSelect()
    } catch (e) {
      toast.error(e?.message || 'Could not archive those')
    } finally {
      setBulkBusy(false)
    }
  }, [bulkConfirming, stages, selected, exitSelect])

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 shell:px-6">
      <PageTitle
        icon={Workflow}
        title="Flow"
        subtitle="Every lead on its way to paid — the next step on each, top to bottom."
      />
      <div className="flex items-center justify-between gap-2">
        <SubNav />
        {anyArchivable && (
          <button
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            className="shrink-0 text-[12px] font-semibold text-link hover:text-link"
          >
            {selectMode ? 'Cancel' : 'Select'}
          </button>
        )}
      </div>
      <div className="mt-4">

      {loading ? (
        <ListSkeleton rows={6} />
      ) : error ? (
        <ErrorState title="Couldn’t load the pipeline" description={error} onRetry={load} />
      ) : stages.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="Nothing in the pipeline"
          description="New requests, quotes out, work to book, and invoices will show up here as they come in."
        />
      ) : (
        <div className="space-y-3">
          {stages.map((s, i) => (
            <Stage key={s.key} stage={s} index={i} onAction={onAction}
              confirmingKey={confirmingKey} busyKey={busyKey}
              selectMode={selectMode} selected={selected} onToggleSelect={toggleSelect} />
          ))}
        </div>
      )}
      </div>

      {selectMode && selected.size > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-20 border-t border-hairline bg-panel/95 px-4 py-3 backdrop-blur"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
        >
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <span className="text-[13px] font-medium text-ink-2">{selected.size} selected</span>
            <button onClick={exitSelect} className="ml-auto text-[12px] font-semibold text-ink-3 hover:text-ink-2">
              Clear
            </button>
            <button
              onClick={archiveSelected}
              disabled={bulkBusy}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-semibold transition-colors disabled:opacity-60 ${
                bulkConfirming
                  ? `border-rose-400 ${STATUS_TEXT.problem}`
                  : 'border-hairline-2 text-ink-2 hover:bg-bg-2'
              }`}
            >
              {bulkBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {bulkConfirming ? `Archive ${selected.size}?` : `Archive ${selected.size}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
