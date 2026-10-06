import { useState } from 'react'
import { ArrowRight, Loader2, PenLine } from 'lucide-react'
import { pushToast } from '../../utils/toastBus'
import { ComposeModal } from '../comms/ComposeModal'
import { SEV_DOT } from './tokens'
import { STATUS_DOT } from '../../theme/statusDots'
import { STATUS_TEXT } from '../../theme/statusText'

/**
 * The second box in Home's comms rail: client conversations waiting on a reply,
 * rendered straight from the board payload's `sections.messages` items — NO new
 * fetch (the board already carries them with their snippet, channel tag, _ago,
 * and the Reply/Resolve actions). Each row is one client: a severity dot (red
 * when overdue/breached), the inbound snippet, and the time. Tapping the row or
 * Reply deep-links to /comms?conversation={id} (Comms.jsx opens that thread);
 * Resolve runs the existing inline api action through OpsBoard's runAction
 * (confirm + spinner + optimistic clear + toast). "Text a client" reuses the
 * shared ComposeModal.
 *
 * Office-only: OpsBoard mounts this only for admin/manager alongside the Crew
 * box, so the whole comms rail is hidden for roles that would 403 on /comms.
 */
const CAP = 5

/**
 * Which channel the client wrote in on.
 *
 * `board_service.py` puts it in `tags[0].label` as the capitalized
 * `Conversation.channel` — "Sms" / "Email" / "Chat" / "Whatsapp" (the column is
 * `nullable=False`, so its `or "message"` fallbacks never fire). The docstring
 * above has claimed since this box shipped that the payload carries a "channel
 * tag"; it does, and the box was dropping it on the floor. On a surface whose
 * whole job is "who is waiting on a reply", how to reply is not a detail.
 *
 * Rendered as a WORD, with no dot. `tags[0].tone` encodes SEVERITY (rose when
 * breached, blue when merely waiting), not channel — so reusing it would colour
 * by urgency while labelling by channel, and the row already says urgency with
 * its leading dot. A second coloured mark on the same row would be the same
 * number twice in two vocabularies.
 */
function channelOf(item) {
  const label = item?.tags?.[0]?.label
  return typeof label === 'string' && label.trim() ? label.trim() : null
}

export default function ClientsBox({ items, cleared, onAction, actioningKey, confirmingKey, navigate }) {
  const [compose, setCompose] = useState(false)
  // Optimistic clear: a resolved conversation drops out of the box (runAction
  // adds it to `cleared`); the board refetch then drops it for real.
  const live = (items || []).filter(it => !cleared.has(it.id))
  const visible = live.slice(0, CAP)
  const hidden = live.length - visible.length

  return (
    <section data-testid="home-clients" className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Clients</h2>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setCompose(true)} title="Text or email a client"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-2 transition-colors hover:text-ink">
            <PenLine className="h-3 w-3" /> Text a client
          </button>
          <button onClick={() => navigate('/comms')}
            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
            Inbox<ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </header>

      {visible.length === 0 ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT.ok}`} aria-hidden="true" />
          <span className="text-[12.5px] text-ink-2">No client replies waiting.</span>
        </div>
      ) : (
        <div className="divide-y divide-hairline">
          {visible.map(it => {
            const reply = (it.actions || []).find(a => a.kind !== 'api')
            const resolve = (it.actions || []).find(a => a.kind === 'api')
            const key = resolve ? `${it.id}:${resolve.label}` : null
            const busy = key && actioningKey === key
            const confirming = key && confirmingKey === key
            const goReply = () => reply ? onAction(it, reply) : navigate('/comms')
            return (
              <div key={it.id} data-testid={`client-row-${it.id}`}
                className="flex items-start gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-bg-2">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[it.severity] || 'bg-ink-3'}`}
                  title={it.severity === 'urgent' ? 'Overdue' : undefined} aria-hidden="true" />
                <button onClick={goReply} className="min-w-0 flex-1 text-left">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug text-ink">{it.title}</span>
                    {(channelOf(it) || it.meta) && (
                      <span className="shrink-0 text-[10.5px] text-ink-3">
                        {channelOf(it)}
                        {channelOf(it) && it.meta ? ' · ' : ''}
                        {it.meta && <span className="tabular-nums">{it.meta}</span>}
                      </span>
                    )}
                  </span>
                  {it.body && <span className="mt-0.5 block truncate text-[11.5px] leading-snug text-ink-2">{it.body}</span>}
                </button>
                {resolve && (
                  <button onClick={() => onAction(it, resolve)} disabled={busy}
                    className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-60 ${
                      confirming
                        ? `border-rose-400 bg-rose-500/10 ${STATUS_TEXT.problem} dark:text-rose-300`
                        : 'border-hairline bg-bg-2 text-ink-2 hover:border-hairline-2 hover:text-ink'
                    }`}>
                    {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                    {confirming ? 'Confirm?' : resolve.label}
                  </button>
                )}
              </div>
            )
          })}
          {hidden > 0 && (
            <button onClick={() => navigate('/comms')}
              className="flex w-full items-center justify-center gap-1 px-3.5 py-2 text-[11.5px] font-medium text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2">
              +{hidden} more — Inbox
            </button>
          )}
        </div>
      )}

      {compose && (
        <ComposeModal clients={[]} onClose={() => setCompose(false)}
          onSent={() => { setCompose(false); pushToast('Message sent', 'success') }} />
      )}
    </section>
  )
}
