/**
 * Me tab — "Message the office" thread (crew side).
 *
 * One thread per cleaner. Sends push to staff; office replies land here
 * (and push back). Fetch on open + after send — no live socket; the push
 * notification is the "you have a reply" signal.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, MessageSquare, Send } from 'lucide-react'
import { get, post } from '../../api'

export function CrewThread({ onClose }) {
  const [msgs, setMsgs] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)

  const load = useCallback(() => {
    get('/api/crew/messages')
      .then(m => { setMsgs(m); setTimeout(() => bottomRef.current?.scrollIntoView(), 50) })
      .catch(e => setError(e.detail || e.message || 'Could not load'))
  }, [])
  useEffect(() => { load() }, [load])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setBusy(true); setError(null)
    try {
      await post('/api/crew/messages', { body: text })
      setDraft('')
      load()
    } catch (e) {
      setError(e.detail || e.message || 'Could not send')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-bg flex flex-col">
      <div className="sticky top-0 bg-panel/95 backdrop-blur border-b border-hairline px-4 py-3 flex items-center gap-3">
        <button onClick={onClose} aria-label="Back"
          className="grid place-items-center w-9 h-9 rounded-lg bg-bg-2 text-ink-2 active:scale-95 transition-transform">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <div className="text-[15px] font-bold text-ink leading-tight">The office</div>
          <div className="text-[11px] text-ink-3">They get a ping when you send</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {!msgs && !error && <div className="h-24 rounded-xl bg-bg-2 animate-pulse" />}
        {msgs?.length === 0 && (
          <p className="text-[12.5px] text-ink-3 text-center pt-8">
            No messages yet — say hi, ask about a schedule, report a problem.
          </p>
        )}
        {(msgs || []).map(m => (
          <div key={m.id} className={`max-w-[85%] ${m.sender === 'cleaner' ? 'ml-auto' : ''}`}>
            <div className={`rounded-2xl px-3.5 py-2 text-[13.5px] whitespace-pre-wrap ${
              m.sender === 'cleaner'
                ? 'bg-blue-600 text-white rounded-br-md'
                : 'bg-panel border border-hairline text-ink rounded-bl-md'}`}>
              {m.body}
            </div>
            <div className={`text-[10px] text-ink-3 mt-0.5 ${m.sender === 'cleaner' ? 'text-right' : ''}`}>
              {m.sender === 'office' ? `${m.sender_name || 'Office'} · ` : ''}
              {m.created_at ? new Date(m.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {error && (
        <div className="px-4 pb-1 text-xs text-red-700">{error}</div>
      )}
      <div className="border-t border-hairline bg-panel px-3 py-2.5 flex items-end gap-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)' }}>
        <textarea value={draft} rows={1} maxLength={2000}
          onChange={e => setDraft(e.target.value)}
          placeholder="Message the office…"
          className="flex-1 resize-none rounded-xl border border-hairline bg-bg px-3 py-2.5 text-[14px] text-ink focus:outline-none focus:border-blue-400" />
        <button onClick={send} disabled={busy || !draft.trim()} aria-label="Send"
          className="grid place-items-center w-11 h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}

/** The Me-tab entry card that opens the thread. */
export default function CrewMessagesCard() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="w-full bg-panel rounded-xl border border-hairline shadow-glass-sm p-4 flex items-center justify-between gap-2 text-left active:scale-[0.99] transition-transform">
        <div>
          <div className="text-sm font-bold text-ink flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4 text-ink-3" /> Message the office
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5">
            Questions, problems, running late — one place, they get pinged.
          </p>
        </div>
        <span className="text-ink-3">›</span>
      </button>
      {open && <CrewThread onClose={() => setOpen(false)} />}
    </>
  )
}
