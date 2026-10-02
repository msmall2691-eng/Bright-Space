import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Workflow } from 'lucide-react'
import { get } from '../api'
import PageTitle from '../components/ui/PageTitle'
import SubNav from '../components/ui/SubNav'
import { ErrorState, EmptyState, ListSkeleton } from '../components/ui'

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
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  red: 'bg-rose-500',
  blue: 'bg-blue-500',
}

// Per-row severity dot + the tone used by row tags (dot + word, never a pill).
const DOT = {
  urgent: 'bg-rose-500',
  watch: 'bg-amber-500',
  info: 'bg-blue-500',
  good: 'bg-emerald-500',
  recurring: 'bg-violet-500',
  // tag tones
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  rose: 'bg-rose-500',
  blue: 'bg-blue-500',
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

function FlowRow({ item, onOpen }) {
  const action = item.actions?.[0]
  const go = () => action && onOpen(action.href)
  return (
    <div
      onClick={go}
      className="flex cursor-pointer items-start gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-bg-2"
    >
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[item.severity] || 'bg-ink-3'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-[13px] font-semibold leading-snug text-ink">{item.title}</p>
          {item.meta && (
            <span className="shrink-0 pt-px text-[10px] font-medium tabular-nums text-ink-3">{item.meta}</span>
          )}
        </div>
        {item.body && <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-ink-2">{item.body}</p>}
        {(item.tags?.length > 0 || action) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {item.tags?.map((t, i) => <Tag key={i} tag={t} />)}
            {action && (
              <button
                onClick={(e) => { e.stopPropagation(); onOpen(action.href) }}
                className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400"
              >
                {action.label}<ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Stage({ stage, onOpen, index }) {
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
        {stage.items.map(it => <FlowRow key={it.id} item={it} onOpen={onOpen} />)}
      </div>
    </section>
  )
}

export default function Flow() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true); setError(null)
    get('/api/dashboard/pipeline')
      .then(d => setData(d))
      .catch(e => setError(e?.message || 'Could not load the pipeline'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const stages = data?.stages || []

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 shell:px-6">
      <PageTitle
        icon={Workflow}
        title="Flow"
        subtitle="Every lead on its way to paid — the next step on each, top to bottom."
      />
      <SubNav className="mb-4" />

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
            <Stage key={s.key} stage={s} index={i} onOpen={(href) => navigate(href)} />
          ))}
        </div>
      )}
    </div>
  )
}
