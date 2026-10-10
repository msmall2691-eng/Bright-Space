import { useRef, useState } from 'react'
import { Send, StickyNote, Sparkles, Loader2, BellRing, CalendarCheck, AtSign } from 'lucide-react'
import { Kbd } from './primitives'
import { apptDatePhrase, apptReminderText, apptConfirmText } from './utils'
import { STATUS_DOT } from '../../theme/statusDots'
import { STATUS_TEXT } from '../../theme/statusText'

const roleLabel = (r) => (r === 'cleaner' ? 'cleaner' : 'office')

/* The generic canned replies are gone, and they are not coming back in this
   shape. There were six — "On our way!", "Running 10 min late", "All done!",
   "Can we reschedule?", "Thanks for your business!", "Your access code is " —
   permanently occupying a row above the textarea on every thread, which on a
   short window is a meaningful slice of the thread pane. The owner, asked
   directly: "the canned replies i dont use ever lol". A control nobody uses
   is not neutral; it costs the vertical space the conversation wanted.

   Two of them were wrong on their own terms, worth recording so a future
   "let's add quick replies" starts from a better place than this did:

     - "On our way!" and "All done!" are the CREW's words, not the office's.
       This composer is the office side of a customer thread.
     - "Your access code is " invited an operator to type a door code into an
       SMS. Not a BB-SEC-08 violation — the operator types it and it is never
       served from the API — but the app should not be the thing suggesting it.

   The appointment-aware chips below (Remind / Confirm) STAY. They are a
   different feature that happens to look similar: they read the customer's
   real next visit and drop in a complete message with the actual date, time
   and first name. That is worth a row because it saves typing nobody wants to
   do twice; a static "Thanks for your business!" is not. */

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
  // reminder/confirmation SMS. onFillReply(text) REPLACES the draft rather
  // than appending to it, so a one-tap reminder lands ready to send.
  nextAppt,
  firstName,
  companyName,
  onFillReply,
  // Teammates taggable with @ in an internal note (office + crew/subs). Typing
  // @ in Note mode opens a picker; each tagged teammate is notified. Empty =
  // no picker (e.g. embeds that don't pass a roster).
  mentionables = [],
}) {
  // Only offer appointment shortcuts on SMS threads with a real upcoming visit.
  const showApptChips = !noteMode && detail.channel === 'sms' && nextAppt && onFillReply

  // @mention picker state (Note mode only). `picked` remembers who was chosen so
  // we can send their user ids; at send we keep only those still present in the
  // text (so deleting the @name un-tags them). `query` is the text typed after @
  // at the caret, or null when the picker is closed.
  const taRef = useRef(null)
  const [query, setQuery] = useState(null)
  const [picked, setPicked] = useState([])

  const suggestions = (query === null || !mentionables.length)
    ? []
    : mentionables
        .filter(u => (u.name || '').toLowerCase().includes(query.toLowerCase()))
        .slice(0, 6)

  const onReplyChange = (e) => {
    const val = e.target.value
    setReply(val)
    if (!noteMode || !mentionables.length) { setQuery(null); return }
    const caret = e.target.selectionStart ?? val.length
    const m = val.slice(0, caret).match(/(?:^|\s)@([\w'’.\-]*)$/)
    setQuery(m ? m[1] : null)
  }

  const pickMention = (u) => {
    const ta = taRef.current
    const caret = ta ? (ta.selectionStart ?? reply.length) : reply.length
    const before = reply.slice(0, caret).replace(/@([\w'’.\-]*)$/, `@${u.name} `)
    const next = before + reply.slice(caret)
    setReply(next)
    setPicked(prev => prev.some(p => p.id === u.id) ? prev : [...prev, u])
    setQuery(null)
    requestAnimationFrame(() => {
      if (ta) { ta.focus(); ta.setSelectionRange(before.length, before.length) }
    })
  }

  const handleSend = () => {
    const mentions = noteMode
      ? picked.filter(p => reply.includes(`@${p.name}`)).map(p => p.id)
      : undefined
    onSend(mentions)
    setPicked([]); setQuery(null)
  }
  return (
    <div className="border-t border-hairline bg-panel px-4 pt-2.5 pb-safe">
      {/* Mode toggle — wraps on narrow phones so the AI button + flash never clip */}
      <div className="flex flex-wrap items-center gap-1.5 gap-y-2 mb-2">
        {/* Reply/Note is a neutral segmented control, not two filled pills —
            note mode carries its amber meaning as selected-state text, not a
            resting fill (owner veto). */}
        <div className="inline-flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5">
          <button onClick={() => setNoteMode(false)}
            className={`inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors ${
              !noteMode ? 'bg-panel text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2'
            }`}>
            <Send className="w-3 h-3" /> Reply
          </button>
          {allowNotes && (
            <button onClick={() => setNoteMode(true)}
              className={`inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors ${
                noteMode ? `bg-panel ${STATUS_TEXT.attention} shadow-xs` : 'text-ink-3 hover:text-ink-2'
              }`}>
              <StickyNote className="w-3 h-3" /> Note
            </button>
          )}
        </div>

        {onDraftAI && !noteMode && (
          <button onClick={onDraftAI} disabled={draftingAI}
            title="Let AI draft a reply — you can edit before sending"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors">
            {draftingAI
              ? <Loader2 className="w-3 h-3 animate-spin text-violet-500" />
              : <Sparkles className="w-3 h-3 text-violet-500" />}
            Draft with AI
          </button>
        )}

        <div className="flex-1" />

        {flash && (
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium animate-fade-in ${
            flash.ok ? STATUS_TEXT.ok : STATUS_TEXT.problem
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${flash.ok ? STATUS_DOT.ok : STATUS_DOT.problem}`} aria-hidden="true" />
            {flash.msg}
          </span>
        )}
      </div>

      {/* Email subject line */}
      {detail.channel === 'email' && !noteMode && (
        <input value={replySubject} onChange={e => setReplySubject(e.target.value)}
          placeholder={detail.subject ? `Re: ${detail.subject}` : 'Subject'}
          className="w-full bg-bg border border-hairline rounded-xl px-3.5 py-2 text-base sm:text-[13px] mb-2 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all" />
      )}

      {/* Appointment-aware quick-replies — pull the customer's real next visit
          into a ready-to-send reminder / confirmation. Hairline secondary
          buttons, not filled pills (owner veto). These REPLACE the draft with
          a whole message rather than appending a fragment, which is why they
          survived the cut of the generic canned replies above: each one is a
          complete, correct message the operator would otherwise retype. */}
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

      {/* @mention picker — Note mode only, opens as you type @ */}
      {noteMode && query !== null && suggestions.length > 0 && (
        <div className="mb-1.5 overflow-hidden rounded-xl border border-hairline bg-panel shadow-lg">
          {suggestions.map(u => (
            <button key={u.id} type="button"
              onMouseDown={e => { e.preventDefault(); pickMention(u) }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-2 transition-colors">
              <AtSign className="w-3.5 h-3.5 shrink-0 text-ink-3" />
              <span className="truncate text-[13px] text-ink">{u.name}</span>
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-ink-3">{roleLabel(u.role)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Reply input */}
      <div className="flex gap-2">
        <textarea ref={taRef} value={reply} onChange={onReplyChange} rows={2}
          placeholder={noteMode
            ? 'Write an internal note (not sent to customer) — type @ to tag a teammate'
            : `Reply via ${(detail.channel || 'sms').toUpperCase()}...`
          }
          className={`flex-1 border border-hairline bg-bg rounded-xl px-4 py-2.5 text-base sm:text-[13px] resize-none placeholder-ink-3 focus:outline-hidden focus:ring-2 focus:bg-panel transition-all leading-relaxed ${
            noteMode ? 'focus:ring-amber-500/20' : 'focus:ring-indigo-500/20'
          }`}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSend() }} />
        <button onClick={handleSend} disabled={sending || !reply.trim()}
          className={`px-5 min-h-[44px] min-w-[64px] rounded-xl text-[13px] font-semibold self-stretch disabled:opacity-40 transition-all active:scale-95 shadow-xs ${
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
      <div className="hidden sm:flex items-center mt-1.5">
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
