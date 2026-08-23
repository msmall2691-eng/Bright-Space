/**
 * Ask — the crew helper (Learn tab).
 *
 * Deliberately NOT a floating widget (owner: "no AI badges get in the way"):
 * it's a quiet search-style box at the top of Learn. Tapping opens a
 * full-screen thread — the same shared <Thread> the office chat uses.
 * Answers are grounded server-side in exactly what this cleaner can
 * already see.
 */
import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { post } from '../../api'
import Thread from './Thread'
import { CrewCard } from './primitives'

const SUGGESTIONS = [
  'What am I doing tomorrow?',
  'How do we clean stainless steel?',
  'Who else is on my job today?',
  'What did the office say about my next job?',
]

function AskThread({ initialQuestion, onClose }) {
  const [msgs, setMsgs] = useState([])          // {role, content}
  const [pending, setPending] = useState(false)
  const startedRef = useRef(false)

  const ask = async (question) => {
    setPending(true)
    setMsgs(m => [...m, { role: 'user', content: question }])
    try {
      const r = await post('/api/crew/ask', { question, history: msgs.slice(-6) })
      setMsgs(m => [...m, { role: 'assistant', content: r.answer }])
    } catch (e) {
      setMsgs(m => [...m, { role: 'assistant', content: e.detail || e.message || "Couldn't answer right now — try again." }])
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    if (initialQuestion && !startedRef.current) {
      startedRef.current = true
      ask(initialQuestion)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Thread
      title="Ask"
      subtitle="Your schedule, this house, how-tos"
      onClose={onClose}
      messages={msgs.map((m, i) => ({ key: i, mine: m.role === 'user', body: m.content }))}
      pending={pending}
      onSend={ask}
      maxLength={500}
      enterToSend
      placeholder="Ask anything…"
    />
  )
}

export default function CrewAsk() {
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState(null)

  const start = (q) => {
    setSeed(q || null)
    setOpen(true)
  }

  return (
    <>
      <CrewCard className="p-3 space-y-2">
        <button onClick={() => start(null)}
          className="w-full flex items-center gap-2 rounded-lg border border-hairline bg-bg px-3 py-2.5 text-left">
          <Search className="w-4 h-4 text-ink-3 shrink-0" />
          <span className="text-[13px] text-ink-3">Ask — schedule, this house, how-tos…</span>
        </button>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
          {SUGGESTIONS.map(s => (
            <button key={s} onClick={() => start(s)}
              className="shrink-0 text-[11px] font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2.5 py-1 hover:bg-bg-2 active:opacity-60 transition-colors">
              {s}
            </button>
          ))}
        </div>
      </CrewCard>
      {open && <AskThread initialQuestion={seed} onClose={() => setOpen(false)} />}
    </>
  )
}
