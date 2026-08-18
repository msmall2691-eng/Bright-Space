/**
 * Ask — the crew helper (Learn tab).
 *
 * Deliberately NOT a floating widget (owner: "no AI badges get in the way"):
 * it's a quiet search-style box at the top of Learn. Tapping opens a
 * full-screen thread, same pattern as messages. Answers are grounded
 * server-side in exactly what this cleaner can already see.
 */
import { useRef, useState } from 'react'
import { ArrowLeft, Search, Send } from 'lucide-react'
import { post } from '../../api'

const SUGGESTIONS = [
  'What am I doing tomorrow?',
  'How do we clean stainless steel?',
  'Who else is on my job today?',
  'What did the office say about my next job?',
]

function AskThread({ initialQuestion, onClose }) {
  const [msgs, setMsgs] = useState([])          // {role, content}
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef(null)
  const startedRef = useRef(false)

  const ask = async (q) => {
    const question = (q || '').trim()
    if (!question || busy) return
    setBusy(true)
    setMsgs(m => [...m, { role: 'user', content: question }])
    setDraft('')
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50)
    try {
      const r = await post('/api/crew/ask', { question, history: msgs.slice(-6) })
      setMsgs(m => [...m, { role: 'assistant', content: r.answer }])
    } catch (e) {
      setMsgs(m => [...m, { role: 'assistant', content: e.detail || e.message || "Couldn't answer right now — try again." }])
    } finally {
      setBusy(false)
      setTimeout(() => bottomRef.current?.scrollIntoView(), 50)
    }
  }

  if (!startedRef.current && initialQuestion) {
    startedRef.current = true
    ask(initialQuestion)
  }

  return (
    <div className="fixed inset-0 z-30 bg-bg flex flex-col">
      <div className="sticky top-0 safe-top bg-panel/95 backdrop-blur border-b border-hairline px-4 py-3 flex items-center gap-3">
        <button onClick={onClose} aria-label="Back"
          className="grid place-items-center w-9 h-9 rounded-lg bg-bg-2 text-ink-2 active:scale-95 transition-transform">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <div className="text-[15px] font-bold text-ink leading-tight">Ask</div>
          <div className="text-[11px] text-ink-3">Your schedule, this house, how-tos</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {msgs.map((m, i) => (
          <div key={i} className={`max-w-[88%] ${m.role === 'user' ? 'ml-auto' : ''}`}>
            <div className={`rounded-2xl px-3.5 py-2 text-[13.5px] whitespace-pre-wrap ${
              m.role === 'user'
                ? 'bg-blue-600 text-white rounded-br-md'
                : 'bg-panel border border-hairline text-ink rounded-bl-md'}`}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="max-w-[88%]">
            <div className="rounded-2xl rounded-bl-md px-3.5 py-2 bg-panel border border-hairline text-ink-3 text-[13.5px]">
              …
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-hairline bg-panel px-3 py-2.5 flex items-end gap-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)' }}>
        <textarea value={draft} rows={1} maxLength={500}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft) } }}
          placeholder="Ask anything…"
          className="flex-1 resize-none rounded-xl border border-hairline bg-bg px-3 py-2.5 text-[14px] text-ink focus:outline-none focus:border-blue-400" />
        <button onClick={() => ask(draft)} disabled={busy || !draft.trim()} aria-label="Ask"
          className="grid place-items-center w-11 h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}

export default function CrewAsk() {
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState(null)
  const [draft, setDraft] = useState('')

  const start = (q) => {
    setSeed(q || draft.trim() || null)
    setDraft('')
    setOpen(true)
  }

  return (
    <>
      <div className="bg-panel rounded-xl border border-hairline shadow-glass-sm p-3 space-y-2">
        <button onClick={() => start(null)}
          className="w-full flex items-center gap-2 rounded-lg border border-hairline bg-bg px-3 py-2.5 text-left">
          <Search className="w-4 h-4 text-ink-3 shrink-0" />
          <span className="text-[13px] text-ink-3">Ask — schedule, this house, how-tos…</span>
        </button>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
          {SUGGESTIONS.map(s => (
            <button key={s} onClick={() => start(s)}
              className="shrink-0 text-[11px] text-ink-2 bg-bg-2 border border-hairline rounded-full px-2.5 py-1 active:opacity-60">
              {s}
            </button>
          ))}
        </div>
      </div>
      {open && <AskThread initialQuestion={seed} onClose={() => setOpen(false)} />}
    </>
  )
}
