/**
 * Thread — the one chat surface, shared by Chat (office messages) and Ask
 * (the crew helper). They were near-identical twins in two files; the real
 * differences ride in as props (maxLength, Enter-to-send, the typing
 * indicator, per-message meta lines).
 *
 * Chat bubbles are a deliberate exception to the no-fills rule: a
 * conversation is the one UI where filled bubbles are the universal idiom
 * (sent = blue, received = panel), not SaaS chrome.
 */
import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { Skeleton } from '../ui'
import { FullScreenSheet } from './primitives'

export default function Thread({
  title, subtitle, onClose,
  messages,                 // [{ key, mine, body, meta? }]
  onSend,                   // async (text) — throw to keep the draft in the box
  placeholder = 'Message…',
  maxLength = 2000,
  enterToSend = false,
  pending = false,          // "…" bubble while an answer is being written
  loading = false,          // skeleton instead of the list (first fetch)
  error = null,
  empty = null,             // line shown when there are no messages yet
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    // Follow the conversation: new message or typing indicator → scroll down.
    const t = setTimeout(() => bottomRef.current?.scrollIntoView(), 50)
    return () => clearTimeout(t)
  }, [messages?.length, pending])

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    setSending(true)
    try { await onSend(text) }
    catch { setDraft(text) }   // failed — put their words back
    finally { setSending(false) }
  }

  return (
    <FullScreenSheet title={title} subtitle={subtitle} onClose={onClose} flex>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {loading && <Skeleton className="h-24 w-full rounded-xl" />}
        {!loading && messages?.length === 0 && empty && (
          <p className="text-[12.5px] text-ink-3 text-center pt-8">{empty}</p>
        )}
        {(messages || []).map(m => (
          <div key={m.key} className={`max-w-[85%] ${m.mine ? 'ml-auto' : ''}`}>
            <div className={`rounded-2xl px-3.5 py-2 text-[13.5px] whitespace-pre-wrap ${
              m.mine
                ? 'bg-blue-600 text-white rounded-br-md'
                : 'bg-panel border border-hairline text-ink rounded-bl-md'}`}>
              {m.body}
            </div>
            {m.meta && (
              <div className={`text-[10px] text-ink-3 mt-0.5 ${m.mine ? 'text-right' : ''}`}>
                {m.meta}
              </div>
            )}
          </div>
        ))}
        {pending && (
          <div className="max-w-[85%]">
            <div className="rounded-2xl rounded-bl-md px-3.5 py-2 bg-panel border border-hairline text-ink-3 text-[13.5px]">
              …
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {error && <div className="px-4 pb-1 text-[12px] text-ink-2 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" /> {error}
      </div>}
      <div className="border-t border-hairline bg-panel px-3 py-2.5 flex items-end gap-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)' }}>
        <textarea value={draft} rows={1} maxLength={maxLength}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={enterToSend
            ? (e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
            : undefined}
          placeholder={placeholder}
          className="flex-1 resize-none rounded-xl border border-hairline bg-bg px-3 py-2.5 text-[14px] text-ink focus:outline-none focus:border-blue-400" />
        <button onClick={send} disabled={sending || pending || !draft.trim()} aria-label="Send"
          className="grid place-items-center w-11 h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">
          <Send className="w-5 h-5" />
        </button>
      </div>
    </FullScreenSheet>
  )
}
