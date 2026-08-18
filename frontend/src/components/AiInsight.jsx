import { useEffect, useState, useCallback } from 'react'
import { Sparkles, ArrowRight, RefreshCw } from 'lucide-react'
import { post } from '../api'

/**
 * AiInsight — a compact, AI-enriched metadata strip for a single record.
 *
 * Drop it at the top of a lead, conversation, quote, or property detail and it
 * lazy-loads a one-line gist + the single most useful next action + a few tags
 * from POST /api/ai/enrich/{type}/{id}. Powered by the cheap tier, so it's fine
 * to load on open; a refresh button re-runs it. Renders nothing on error/404 so
 * it never leaves an empty box behind.
 *
 *   <AiInsight type="lead" id={intake.id} />
 */
export default function AiInsight({ type, id, className = '' }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    if (!type || !id) return
    setLoading(true); setFailed(false)
    post(`/api/ai/enrich/${type}/${id}`, {})
      .then(d => {
        if (d?.error || !d?.summary) { setFailed(true); setData(null) }
        else setData(d)
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [type, id])

  useEffect(() => { load() }, [load])

  // Nothing to show — don't leave an empty frame.
  if (failed && !loading) return null

  return (
    <div className={`rounded-xl border border-hairline bg-panel px-3.5 py-3 ${className}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500 dark:bg-violet-400" aria-hidden />
        <Sparkles className="w-3.5 h-3.5 text-ink-3" />
        <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3">
          AI insight
        </span>
        {data && !data.ai && (
          <span className="text-[10px] text-ink-3">· quick summary</span>
        )}
        {!loading && (
          <button onClick={load} title="Regenerate"
            className="ml-auto text-ink-3 hover:text-ink-2">
            <RefreshCw className="w-3 h-3" />
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-1.5">
          <div className="h-3 rounded bg-bg-2 animate-pulse w-11/12" />
          <div className="h-3 rounded bg-bg-2 animate-pulse w-2/3" />
        </div>
      ) : data ? (
        <>
          <p className="text-[12.5px] text-ink leading-snug">{data.summary}</p>
          {data.next_action && (
            <div className="flex items-center gap-1 mt-1.5 text-[12px] font-semibold text-ink-2">
              <ArrowRight className="w-3.5 h-3.5 shrink-0" />
              {data.next_action}
            </div>
          )}
          {data.tags?.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
              {data.tags.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500 dark:bg-violet-400" aria-hidden />
                  {t}
                </span>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
