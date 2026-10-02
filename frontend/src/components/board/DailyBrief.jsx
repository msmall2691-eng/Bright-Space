/**
 * The AI morning brief — one quiet paragraph about the day.
 *
 * MOVED OFF HOME (Oct 2026). This used to sit under the Ops Board header. The
 * owner's verdict on the landing page was "too much at once" and "can't find
 * what I need", and in that triage both AI strips went: a paragraph you skim
 * is not what the first screen of the morning is for, and its fetch was one of
 * two AI calls racing the real data on first paint. It now opens the Assistant
 * tab (Workspace), where reading something an agent wrote is the point of the
 * page rather than an interruption on the way to the calendar.
 *
 * Extracted verbatim from OpsBoard.jsx rather than rewritten — the behaviour
 * below was already right and is load-bearing:
 *
 *   - ONE fetch, on mount. The backend caches the prose per business day, so
 *     this is cheap; the refresh button is the only way to spend a completion.
 *   - ON ANY FAILURE IT RENDERS NOTHING. Not an error card, not a retry — the
 *     page's real data must never sit behind, or visually blame, a nicety.
 *     Keep it that way: a broken brief should be invisible, not a problem the
 *     operator has to dismiss.
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'

import { get } from '../../api'

function fmtBriefTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch { return '' }
}

export default function DailyBrief() {
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
