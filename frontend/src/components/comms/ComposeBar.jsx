import { Send, StickyNote, Sparkles, Loader2, BellRing, CalendarCheck } from 'lucide-react'
import { Kbd } from './primitives'
import { apptDatePhrase, apptReminderText, apptConfirmText } from './utils'

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
  // Optional: when provided, shows a "Draft with AI" button that asks the
  // caller to fill the reply (e.g. draft a first reply to a new lead). Called
  // with no args; the caller knows the context (intake / conversation).
  onDraftAI,
  draftingAI = false,
  // Appointment-aware quick-replies: the customer's soonest upcoming job (or
  // undefined), their first name, and the company name feed pre-composed
  // reminder/confirmation SMS. onFillReply(text) REPLACES the draft (vs. the
  // canned chips below, which append) so a one-tap reminder lands ready to send.
  nextAppt,
  firstName,
  companyName,
  onFillReply,
}) {
  // Only offer appointment shortcuts on SMS threads with a real upcoming visit.
  const showApptChips = !noteMode && detail.channel === 'sms' && nextAppt && onFillReply
  return (
    <div className="border-t border-hairline bg-panel px-4 pt-4 pb-safe">
      {/* Mode toggle — wraps on narrow phones so the AI button + flash never clip */}
      <div className="flex flex-wrap items-center gap-1.5 gap-y-2 mb-3">
        <button onClick={() => setNoteMode(false)}
          className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-all ${
            !noteMode ? 'bg-indigo-600 text-white shadow-sm' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'
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

        {onDraftAI && !noteMode && (
          <button onClick={onDraftAI} disabled={draftingAI}
            title="Let AI draft a reply — you can edit before sending"
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-500/25 disabled:opacity-50 transition-all">
            {draftingAI ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            Draft with AI
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
          className="w-full bg-bg border border-hairline rounded-xl px-3.5 py-2 text-base sm:text-[13px] mb-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all" />
      )}

      {/* Appointment-aware quick-replies — pull the customer's real next visit
          into a ready-to-send reminder / confirmation. Same hairline
          secondary-button style as the canned chips below (owner's veto of
          filled pill bubbles) — these drop in a whole message, not append. */}
      {showApptChips && (
        <div className="flex items-center gap-1.5 mb-2 overflow-x-auto pb-1 scrollbar-thin">
          <span className="shrink-0 text-[10px] font-semibold text-ink-3 uppercase tracking-wide pr-0.5">
            {apptDatePhrase(nextAppt)}
          </span>
          <button
            onClick={() => onFillReply(apptReminderText({ job: nextAppt, firstName, company: companyName }))}
            className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2 transition-colors whitespace-nowrap">
            <BellRing className="w-3 h-3" /> Remind
          </button>
          <button
            onClick={() => onFillReply(apptConfirmText({ job: nextAppt, firstName }))}
            className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2 transition-colors whitespace-nowrap">
            <CalendarCheck className="w-3 h-3" /> Confirm
          </button>
        </div>
      )}

      {/* Canned responses — one-tap fills the reply box */}
      {!noteMode && (
        <div className="flex gap-1.5 mb-2 overflow-x-auto pb-1 scrollbar-thin">
          {CANNED_REPLIES.map(t => (
            <button key={t} onClick={() => setReply(prev => prev ? prev + ' ' + t : t)}
              className="shrink-0 text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2 transition-colors whitespace-nowrap">
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
          className={`flex-1 border rounded-xl px-4 py-3 text-base sm:text-[13px] resize-none focus:outline-none focus:ring-2 transition-all leading-relaxed ${
            noteMode
              ? 'border-amber-200 bg-amber-50/50 focus:ring-amber-500/20 placeholder-amber-400'
              : 'border-hairline bg-bg focus:ring-indigo-500/20 focus:bg-panel placeholder-ink-3'
          }`}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onSend() }} />
        <button onClick={onSend} disabled={sending || !reply.trim()}
          className={`px-5 min-h-[44px] min-w-[64px] rounded-xl text-[13px] font-semibold self-stretch disabled:opacity-40 transition-all active:scale-95 shadow-sm ${
            noteMode
              ? 'bg-amber-500 hover:bg-amber-600 text-white'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white'
          }`}>
          {sending
            ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            : noteMode ? 'Save' : 'Send'
          }
        </button>
      </div>

      {/* Keyboard-shortcut hint is desktop-only — hidden where there's no keyboard */}
      <div className="hidden sm:flex items-center mt-2">
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
