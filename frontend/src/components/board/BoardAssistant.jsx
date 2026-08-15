/**
 * BoardAssistant — the "Ask" panel for the Ops Board.
 *
 * BrightBase already has a per-page assistant (PageAssistant), but it's
 * desktop-only and not board-aware. This is a board-native, mobile-first sheet:
 * a deterministic rundown built from the board data already in hand (no AI cost),
 * board-tailored prompts, one-tap actions, and a data-grounded Ask box that
 * reuses the existing POST /api/ai/quick (which answers via read-only business
 * tools). Renders as a bottom sheet on phones, a right-hand panel on desktop.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Send, Loader2, Sparkles, ChevronRight, Zap, Trash2 } from 'lucide-react'
import { get, post } from '../../api'
import MarkdownContent from '../workspace/MarkdownContent'
import { SEV_DOT } from './tokens'

const SUGGESTIONS = [
  'What’s most urgent right now?',
  'Summarize what needs me today',
  'Which invoices should I chase?',
  'Who’s been waiting longest for a reply?',
]

function firstLink(item) {
  return (item.actions || []).find(a => a.kind !== 'api' && a.href)?.href || null
}

export default function BoardAssistant({ open, onClose, sections, navigate, onActed }) {
  const [query, setQuery] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState(null)
  const [actionMsg, setActionMsg] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50) }, [open])
  useEffect(() => { if (!open) setConfirmClear(false) }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Deterministic rundown from the board already loaded — urgent/watch first.
  const rundown = useMemo(() => {
    const rank = { urgent: 0, watch: 1, info: 2, good: 3, recurring: 4 }
    const items = (sections || [])
      .filter(s => s.key !== 'safe_to_ignore')
      .flatMap(s => s.items.map(it => ({ ...it, section: s.title })))
      .filter(it => it.severity === 'urgent' || it.severity === 'watch')
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
    return items.slice(0, 5)
  }, [sections])

  const ask = async (text) => {
    const q = (typeof text === 'string' ? text : query).trim()
    if (!q || asking) return
    setQuery(q); setAsking(true); setAnswer(null)
    try {
      const res = await post('/api/ai/quick', { question: q, page_context: 'dashboard' })
      setAnswer(res?.answer || 'No answer.')
    } catch {
      setAnswer('Sorry — I couldn’t answer that right now.')
    }
    setAsking(false)
  }

  const draftReminders = async () => {
    setActionMsg('working')
    try {
      const res = await get('/api/ai/overdue-reminders')
      const n = res?.total || (res?.reminders || []).length || 0
      setActionMsg(n > 0
        ? { text: `Drafted ${n} reminder${n > 1 ? 's' : ''} — review & send in Billing.`, to: '/billing?view=invoices' }
        : { text: 'No overdue invoices right now. ✨' })
    } catch {
      setActionMsg({ text: 'Could not draft reminders right now.' })
    }
  }

  // How many "Safe to Ignore" cards are on the board right now — the noise the
  // one-tap cleanup deletes (moves to Gmail Trash where possible, always clears
  // the board). Two-tap confirm since it's a bulk delete.
  const noiseCount = useMemo(() => {
    const safe = (sections || []).find(s => s.key === 'safe_to_ignore')
    return safe?.items?.length || 0
  }, [sections])

  const clearNoise = async () => {
    if (!noiseCount) { setActionMsg({ text: 'Nothing to clear — Safe to Ignore is empty. ✨' }); return }
    if (!confirmClear) { setConfirmClear(true); return }
    setConfirmClear(false); setActionMsg('working')
    try {
      const res = await post('/api/inbox/triage/delete-all?section=safe_to_ignore', {})
      const cleared = res?.deleted ?? noiseCount
      const trashed = res?.gmail_trashed ?? 0
      setActionMsg({ text: trashed > 0
        ? `Cleared ${cleared} — ${trashed} moved to Gmail Trash.`
        : `Cleared ${cleared} from the board.` })
      onActed?.()
    } catch {
      setActionMsg({ text: 'Could not clear the noise right now.' })
    }
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed z-50 flex flex-col bg-panel shadow-2xl border border-hairline overflow-hidden
        inset-x-0 bottom-0 rounded-t-2xl max-h-[85dvh]
        sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:w-[400px] sm:max-h-none sm:rounded-none sm:border-y-0 sm:border-r-0">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-indigo-500/10 text-indigo-500">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-tight text-ink">Ask</p>
            <p className="text-[11px] leading-tight text-ink-3">Your board assistant</p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="rounded-lg p-1.5 text-ink-3 hover:bg-bg-2 hover:text-ink-2">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {/* Rundown */}
          <div>
            <p className="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-wider text-ink-3">Rundown</p>
            {rundown.length === 0 ? (
              <p className="px-1 py-1.5 text-[12px] text-ink-3">All clear — nothing urgent right now. ✨</p>
            ) : (
              <div className="space-y-1">
                {rundown.map((it) => {
                  const href = firstLink(it)
                  return (
                    <button key={it.id} onClick={() => { if (href) { onClose(); navigate(href) } }}
                      className="group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-bg-2">
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[it.severity] || 'bg-ink-3'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-ink">{it.title}</span>
                        {it.body && <span className="block truncate text-[11px] text-ink-3">{it.body}</span>}
                      </span>
                      {href && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3 group-hover:text-ink-2" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Answer */}
          {(asking || answer) && (
            <div className="rounded-lg border border-hairline bg-bg-2/50 p-2.5">
              {asking
                ? <div className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…</div>
                : <MarkdownContent text={answer} />}
            </div>
          )}

          {/* Quick actions + suggestions */}
          {!answer && !asking && (
            <>
              <div>
                <p className="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-wider text-ink-3">Quick actions</p>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={draftReminders}
                    className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-[12px] font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300">
                    <Zap className="h-3 w-3" /> Draft overdue reminders
                  </button>
                  <button onClick={clearNoise}
                    className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium ${
                      confirmClear
                        ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-300'
                        : 'border-hairline bg-bg text-ink-2 hover:bg-bg-2'}`}>
                    <Trash2 className="h-3 w-3" />
                    {confirmClear
                      ? `Delete ${noiseCount}? Tap to confirm`
                      : `Clear the noise${noiseCount ? ` (${noiseCount})` : ''}`}
                  </button>
                </div>
                {actionMsg && (
                  <div className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-2">
                    {actionMsg === 'working'
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…</>
                      : <><span>{actionMsg.text}</span>{actionMsg.to && (
                          <button onClick={() => { onClose(); navigate(actionMsg.to) }} className="font-semibold text-indigo-600 hover:text-indigo-500">Open →</button>
                        )}</>}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-wider text-ink-3">Ask about your day</p>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((s, i) => (
                    <button key={i} onClick={() => ask(s)}
                      className="rounded-lg border border-hairline bg-bg px-2.5 py-1.5 text-left text-[12px] text-ink-2 hover:border-hairline-2 hover:bg-bg-2">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {answer && !asking && (
            <button onClick={() => { setAnswer(null); setQuery('') }}
              className="text-[12px] font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
              ← Ask something else
            </button>
          )}
        </div>

        {/* Ask input */}
        <div className="border-t border-hairline p-2.5">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
              rows={1} placeholder="Ask about your board…"
              className="max-h-24 flex-1 resize-none rounded-lg border border-hairline bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-indigo-400 focus:outline-none" />
            <button onClick={() => ask()} disabled={!query.trim() || asking}
              className="shrink-0 rounded-lg bg-indigo-600 p-2 text-white hover:bg-indigo-500 disabled:opacity-40">
              {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
