import { useEffect, useRef, useState } from 'react'
import { Send, Loader2, Sparkles, ArrowRight } from 'lucide-react'
import { askBoard } from './askBoard'
import { currentRole } from '../../nav/routes'
import MarkdownContent from '../workspace/MarkdownContent'

/**
 * Nova chat on Home — a persistent box to ask about the business in plain words.
 *
 * Reuses askBoard() (POST /api/ai/quick, page_context 'dashboard') — the same
 * read-only, data-grounded path BoardAssistant and AgentHelp use, so all three
 * give the same answer to the same question. It ANSWERS, it doesn't act: taking
 * an action (send, draft, schedule) is the full assistant on Workspace, linked
 * from the header. Office-only, matching the endpoint's role gate.
 */
const SUGGESTIONS = [
  "What's most urgent right now?",
  "Who's unassigned this weekend?",
  'Which invoices should I chase?',
]

export default function NovaChat({ navigate }) {
  const role = currentRole()
  const [msgs, setMsgs] = useState([])   // { who: 'me'|'nova', text }
  const [q, setQ] = useState('')
  const [asking, setAsking] = useState(false)
  const threadRef = useRef(null)

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [msgs, asking])

  if (role !== 'admin' && role !== 'manager') return null

  const ask = async (question) => {
    const text = String(question || '').trim()
    if (!text || asking) return
    setMsgs(m => [...m, { who: 'me', text }])
    setQ('')
    setAsking(true)
    const { answer, error } = await askBoard(text)
    setMsgs(m => [...m, {
      who: 'nova',
      text: error ? "I couldn't pull that up just now — try again in a moment." : answer,
    }])
    setAsking(false)
  }

  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-hairline bg-panel" data-testid="home-nova-chat">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <Sparkles className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
        <h2 className="text-[11px] font-medium text-ink-3">Ask Nova</h2>
        <button onClick={() => navigate('/workspace')}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
          Full assistant<ArrowRight className="h-3 w-3" />
        </button>
      </header>

      <div ref={threadRef} className="max-h-[280px] min-h-[120px] flex-1 space-y-2.5 overflow-y-auto px-3.5 py-3">
        {msgs.length === 0 && (
          <div className="space-y-2">
            <p className="text-[12px] text-ink-3">Ask me anything about your business — I read your live data.</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => ask(s)}
                  className="rounded-lg border border-hairline bg-bg-2/50 px-2.5 py-1 text-[11px] text-ink-2 transition-colors hover:border-indigo-500 hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          m.who === 'me' ? (
            <div key={i} className="ml-auto max-w-[88%] rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-[12.5px] text-white">
              {m.text}
            </div>
          ) : (
            <div key={i} className="max-w-[92%] rounded-2xl rounded-bl-sm border border-hairline bg-bg-2/40 px-3 py-2 text-[12.5px] text-ink">
              <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-wide text-ink-3">Nova</div>
              <MarkdownContent content={m.text} />
            </div>
          )
        ))}

        {asking && (
          <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Nova is thinking…
          </div>
        )}
      </div>

      <form className="flex items-center gap-2 border-t border-hairline px-3 py-2.5"
        onSubmit={e => { e.preventDefault(); ask(q) }}>
        <input value={q} onChange={e => setQ(e.target.value)} disabled={asking}
          placeholder="Ask about your schedule, money, leads…"
          aria-label="Ask Nova"
          className="min-w-0 flex-1 rounded-xl border border-hairline-2 bg-bg-2/50 px-3 py-2 text-[12.5px] text-ink placeholder-ink-3 focus:border-indigo-500 focus:outline-none disabled:opacity-60" />
        <button type="submit" disabled={asking || !q.trim()} aria-label="Send"
          className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 text-white transition-opacity disabled:opacity-40">
          <Send className="h-4 w-4" />
        </button>
      </form>
    </section>
  )
}
