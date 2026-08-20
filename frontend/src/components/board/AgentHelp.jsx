/**
 * AgentHelp — "Ask an agent" on Home.
 *
 * The problem this fixes: the board's real conversational helper
 * (BoardAssistant) is hidden behind an "Ask" button in the page header, so it
 * only helps someone who already remembers it exists. The daily brief, at the
 * other extreme, is prose you can only read. This widget is the middle: four
 * one-tap prompts sitting in a grid cell, answered in place.
 *
 * WHAT MAKES THE PROMPTS RELEVANT: the same free, deterministic scan the
 * Workspace's suggested tasks and the "needs attention" tile already use
 * (GET /api/ai/followup-check — overdue invoices, uncovered guest checkouts,
 * unassigned jobs, stale feeds/quotes/leads). No LLM runs to build the row;
 * the model is only paid for when she actually taps something.
 *
 * REQUEST ECONOMY (skills/brightbase-economy):
 *   - The scan result is cached per business day in localStorage under the
 *     SAME key Workspace uses, so Home and Workspace share one scan a day
 *     rather than one each. On a warm day this widget costs ZERO requests.
 *   - The cold fetch goes through `getCached`, which collapses StrictMode's
 *     double mount (and any same-minute repeat) into one request.
 *   - No polling, no interval, no refetch-on-focus. A dashboard hint that is
 *     a few minutes stale costs nothing.
 *   - It does NOT refetch anything Home already has (board / daily-brief /
 *     proposals / crew threads). Ideally the followup items would arrive as a
 *     prop — /api/ai/daily-brief already returns them and Home already calls
 *     it — but every Home widget is self-contained on purpose so one failure
 *     can't blank the board, so this keeps its own (cheap, shared, cached)
 *     read and the day-cache buys back the cost.
 *
 * ASKING: goes through askBoard() (POST /api/ai/quick, page_context
 * 'dashboard') — the exact same path BoardAssistant uses, not a second one.
 * If the parent passes `onOpenAssistant`, a tap hands the prompt to that
 * bigger panel instead of answering inline; without it the widget answers on
 * its own so it is fully usable with `{ navigate }` alone.
 *
 * DEGRADING (skills/brightbase-design-language): the scan failing is not
 * news — the widget silently falls back to the general prompts, which need no
 * data at all. A failed or unconfigured model is one calm line, never an
 * error card. Nothing here is a filled pill, tinted banner, or count bubble;
 * status is a 6px dot plus a plain word, and there is no primary button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Loader2, Sparkles } from 'lucide-react'
import { getCached } from '../../api'
import { askBoard } from './askBoard'
import MarkdownContent from '../workspace/MarkdownContent'
import { todayYMD } from '../../utils/format'

// Shared with pages/Workspace.jsx on purpose — same scan, same business day,
// one fetch between them. Shape: { date, items, dismissed? }; `dismissed` is
// Workspace's own UI state and is preserved, never read, here.
const SUGGESTIONS_CACHE_KEY = 'brightbase_workspace_suggestions'
const SCAN_URL = '/api/ai/followup-check'

/** Prompts that need no data — always available, always answerable. */
const GENERAL = [
  { key: 'today', label: 'What needs me today?',
    prompt: 'What needs my attention today? Just the top few things, shortest first.' },
  { key: 'week', label: 'How does this week look?',
    prompt: 'How does the coming week look — what work is booked, and what still needs a cleaner?' },
  { key: 'waiting', label: 'Who’s waiting on me?',
    prompt: 'Which clients or leads have been waiting longest for a reply from me?' },
]

/**
 * followup item → the question an owner would actually ask about it.
 * Matched on the item's own words, so a backend wording change degrades to
 * "no contextual prompt" rather than to a wrong one. Order = the order they
 * are offered when several match.
 */
const CONTEXTUAL = [
  { key: 'invoices', test: /invoice|overdue|past due/i,
    label: 'Chase overdue invoices',
    prompt: 'Which invoices are overdue, how much is outstanding, and who should I chase first?' },
  { key: 'turnovers', test: /turnover|checkout/i,
    label: 'Uncovered turnovers',
    prompt: 'Which upcoming guest checkouts have no turnover scheduled yet?' },
  { key: 'unassigned', test: /unassigned|cleaner/i,
    label: 'Jobs with no cleaner',
    prompt: 'Which upcoming jobs still have no cleaner assigned, and which are soonest?' },
  { key: 'feeds', test: /feed|ical/i,
    label: 'Rental feeds',
    prompt: 'Which rental booking feeds are stale or missing, and what do I miss if they stay broken?' },
  { key: 'quotes', test: /quote/i,
    label: 'Quotes waiting',
    prompt: 'Which quotes are still waiting on a client answer, and how old are they?' },
  { key: 'leads', test: /lead|inquiry|request|unanswered/i,
    label: 'Leads to answer',
    prompt: 'Which new leads or requests haven’t been answered yet?' },
]

// Severity → the leading dot. Dot + word only (the owner's standing veto on
// filled/tinted labels); undefined severity gets no dot at all.
const SEV_DOT = { high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-ink-3' }

/** Contextual prompts first (max 3), topped up with generals to four. */
export function buildSuggestions(items) {
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    if (out.length >= 3) break
    const hay = `${it?.title || ''} ${it?.detail || ''} ${it?.action || ''}`
    const match = CONTEXTUAL.find(c => c.test.test(hay) && !out.some(o => o.key === c.key))
    if (match) out.push({ ...match, severity: it?.severity })
  }
  for (const g of GENERAL) {
    if (out.length >= 4) break
    if (!out.some(o => o.key === g.key)) out.push(g)
  }
  return out.slice(0, 4)
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(SUGGESTIONS_CACHE_KEY) || 'null') }
  catch { return null }
}

function writeCache(items) {
  try {
    const prev = readCache()
    localStorage.setItem(SUGGESTIONS_CACHE_KEY, JSON.stringify({
      date: todayYMD(), items, dismissed: prev?.dismissed ?? false,
    }))
  } catch { /* storage full or blocked — non-fatal, we just re-scan tomorrow */ }
}

export default function AgentHelp({ navigate, onOpenAssistant }) {
  // loading → the day's scan is in flight | ready → grounded in real items
  // | empty → scan came back (or failed) with nothing to ground on.
  const [state, setState] = useState('loading')
  const [items, setItems] = useState([])
  const [asking, setAsking] = useState(null)      // the prompt currently running
  const [answer, setAnswer] = useState(null)      // { label, text } | { label, calm }
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    const cached = readCache()
    if (cached?.date === todayYMD()) {
      const list = Array.isArray(cached.items) ? cached.items : []
      setItems(list)
      setState(list.length ? 'ready' : 'empty')
      return
    }
    getCached(SCAN_URL, 60_000).then(data => {
      if (!alive.current) return
      const list = (data?.followups || []).slice(0, 5)
      setItems(list)
      setState(list.length ? 'ready' : 'empty')
      writeCache(list)
    }).catch(() => {
      // Quiet by design: the general prompts below work with no data at all,
      // so a failed scan costs relevance, not the widget.
      if (alive.current) { setItems([]); setState('empty') }
    })
  }, [])

  const suggestions = useMemo(() => buildSuggestions(items), [items])

  const run = useCallback(async (s) => {
    if (asking) return
    // Handed a bigger surface? Use it — one prompt, one assistant, no second
    // conversation to keep track of.
    if (onOpenAssistant) { onOpenAssistant(s.prompt); return }
    setAsking(s.prompt); setAnswer(null)
    const res = await askBoard(s.prompt)
    if (!alive.current) return
    setAsking(null)
    setAnswer(res.error || !res.answer
      ? { label: s.label, calm: res.answer || 'Couldn’t answer that right now.' }
      : { label: s.label, text: res.answer })
  }, [asking, onOpenAssistant])

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none">✨</span>
        <h2 className="text-[11px] font-medium text-ink-3">Ask an agent</h2>
        <button onClick={() => navigate('/workspace')}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
          Agents<ArrowRight className="h-3 w-3" />
        </button>
      </header>

      {state === 'loading' ? (
        <div className="flex flex-wrap gap-1.5 p-3">
          {[0, 1, 2].map(i => <div key={i} className="h-7 w-40 animate-pulse rounded-lg bg-bg-2" />)}
        </div>
      ) : (
        <div className="space-y-2 p-3">
          {state === 'empty' && !answer && !asking && (
            <p className="px-0.5 text-[12px] text-ink-3">
              Nothing’s flagged right now — ask anything about the business.
            </p>
          )}

          {/* One-tap prompts. Plain hairline buttons, wrapping — never filled
              chips; the dot is the only color and it means "this one came
              from something that needs attention". */}
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map(s => (
              <button key={s.key} onClick={() => run(s)} disabled={!!asking}
                data-testid={`agent-prompt-${s.key}`}
                title={s.prompt}
                className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-hairline bg-bg px-2.5 py-1.5 text-left text-[12px] text-ink-2 transition-colors hover:border-hairline-2 hover:bg-bg-2 disabled:opacity-50">
                {s.severity && (
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[s.severity] || SEV_DOT.low}`}
                    aria-hidden="true" />
                )}
                <span className="min-w-0 truncate">{s.label}</span>
              </button>
            ))}
          </div>

          {asking && (
            <div className="flex items-center gap-2 px-0.5 text-[12px] text-ink-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Thinking…
            </div>
          )}

          {answer && !asking && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-ink-3">
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                <span className="truncate">{answer.label}</span>
              </div>
              {/* Bounded so a long answer can't stretch the grid row. */}
              <div className="max-h-[200px] overflow-y-auto rounded-lg border border-hairline px-2.5 py-2">
                {answer.text
                  ? <MarkdownContent text={answer.text} />
                  : <p className="text-[12px] text-ink-2">{answer.calm}</p>}
              </div>
              <button onClick={() => setAnswer(null)}
                className="px-0.5 text-[11px] font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                Ask something else
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
