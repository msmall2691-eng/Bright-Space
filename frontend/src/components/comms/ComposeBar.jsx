import { Send, StickyNote } from 'lucide-react'
import { Kbd } from './primitives'

const CANNED_REPLIES = [
  'On our way!',
  'Running 10 min late',
  'All done!',
  'Can we reschedule?',
  'Thanks for your business!',
  'Your access code is ',
]

/** Reply / internal-note composer at the bottom of the thread view.
 *  Owns nothing — every input is a controlled prop from the parent so the
 *  Comms page can keep the send action, flash toast, and API wiring in one
 *  place. Cmd/Ctrl+Enter sends. */
export function ComposeBar({
  detail,
  reply, setReply,
  replySubject, setReplySubject,
  noteMode, setNoteMode,
  sending,
  flash,
  onSend,
  // Internal notes need an existing conversation id to attach to. Callers
  // embedding this bar before any message has been sent (e.g. the Requests
  // drawer's inline thread panel, still on its first send) pass false to
  // hide the toggle entirely rather than let the operator pick a mode with
  // nowhere to save.
  allowNotes = true,
}) {
  return (
    <div className="border-t border-hairline bg-panel p-4">
      {/* Mode toggle */}
      <div className="flex items-center gap-1.5 mb-3">
        <button onClick={() => setNoteMode(false)}
          className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-all ${
            !noteMode ? 'bg-blue-600 text-white shadow-sm' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'
          }`}>
          <Send className="w-3 h-3" /> Reply
        </button>
        {allowNotes && (
          <button onClick={() => setNoteMode(true)}
            className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-all ${
              noteMode ? 'bg-amber-500 text-white shadow-sm' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'
            }`}>
            <StickyNote className="w-3 h-3" /> Note
          </button>
        )}

        <div className="flex-1" />

        {flash && (
          <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg animate-fade-in ${
            flash.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}>{flash.msg}</span>
        )}
      </div>

      {/* Email subject line */}
      {detail.channel === 'email' && !noteMode && (
        <input value={replySubject} onChange={e => setReplySubject(e.target.value)}
          placeholder={detail.subject ? `Re: ${detail.subject}` : 'Subject'}
          className="w-full bg-bg border border-hairline rounded-xl px-3.5 py-2 text-[13px] mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all" />
      )}

      {/* Canned responses — one-tap fills the reply box */}
      {!noteMode && (
        <div className="flex gap-1.5 mb-2 overflow-x-auto pb-1 scrollbar-thin">
          {CANNED_REPLIES.map(t => (
            <button key={t} onClick={() => setReply(prev => prev ? prev + ' ' + t : t)}
              className="shrink-0 text-[11px] font-medium px-2.5 py-1 rounded-full border border-hairline bg-panel text-ink-2 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors whitespace-nowrap">
              {t}
            </button>
          ))}
        </div>
      )}

      {/* Reply input */}
      <div className="flex gap-2">
        <textarea value={reply} onChange={e => setReply(e.target.value)} rows={2}
          placeholder={noteMode
            ? 'Write an internal note (not sent to customer)...'
            : `Reply via ${(detail.channel || 'sms').toUpperCase()}...`
          }
          className={`flex-1 border rounded-xl px-4 py-3 text-[13px] resize-none focus:outline-none focus:ring-2 transition-all leading-relaxed ${
            noteMode
              ? 'border-amber-200 bg-amber-50/50 focus:ring-amber-500/20 placeholder-amber-400'
              : 'border-hairline bg-bg focus:ring-blue-500/20 focus:bg-panel placeholder-ink-3'
          }`}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onSend() }} />
        <button onClick={onSend} disabled={sending || !reply.trim()}
          className={`px-5 rounded-xl text-[13px] font-semibold self-stretch disabled:opacity-40 transition-all active:scale-95 shadow-sm ${
            noteMode
              ? 'bg-amber-500 hover:bg-amber-600 text-white'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}>
          {sending
            ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            : noteMode ? 'Save' : 'Send'
          }
        </button>
      </div>

      <div className="flex items-center mt-2">
        <div className="text-[10px] text-ink-3 flex items-center gap-1">
          <Kbd>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}</Kbd>
          <span>+</span>
          <Kbd>Enter</Kbd>
          <span className="ml-1">to send</span>
        </div>
      </div>
    </div>
  )
}
