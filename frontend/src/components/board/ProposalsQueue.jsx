/**
 * "Waiting for your approval" — the Autopilot approval queue on Home.
 *
 * Two kinds of row land here, and they need different treatment:
 *
 *   STRUCTURAL (assign this cleaner, create this job from a calendar event) —
 *     the payload IS the decision. Approve or dismiss, nothing to edit.
 *   A DRAFTED MESSAGE (`send_sms`) — level 2: a persona wrote a reply to a
 *     customer who's been waiting, or a nudge on a quote gone quiet, and
 *     parked it here rather than making the owner find it and write it.
 *
 * A drafted message you can't touch is take-it-or-leave-it, and "leave it"
 * means writing the whole thing yourself — worse than no draft at all. So the
 * message shows as editable text, and "Send it" saves any edit first
 * (PATCH /api/ai/proposals/{id}) and only then approves. Nothing is ever sent
 * without that tap.
 *
 * REQUEST ECONOMY (skills/brightbase-economy):
 *   - One list fetch on mount. No polling; a decision updates the row in
 *     place, and the whole board reloads on navigation anyway.
 *   - The drafting run costs completions, so it fires AT MOST ONCE PER
 *     BUSINESS DAY per browser (localStorage day-key, the same shape
 *     AgentHelp's scan cache uses), only when the owner actually opens Home,
 *     and the backend caps and de-duplicates it besides. There is no tick:
 *     a timer would spend money every morning whether or not anyone looked.
 *   - The day-key is written BEFORE the request, not after — a failed or slow
 *     run must not turn into a retry on every reload.
 *
 * DESIGN (skills/brightbase-design-language): the panel is quiet — a hairline
 * card, an indigo dot, a plain count (never a bubble), one primary button per
 * row. Failure is a line of text, not a tinted card.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { get, patch, post } from '../../api'
import { pushToast } from '../../utils/toastBus'
import { todayYMD } from '../../utils/format'

const DRAFT_RUN_KEY = 'brightbase_autopilot_drafts_run'
const DRAFT_URL = '/api/ai/autopilot/draft-followups'

/** True at most once per business day per browser; stamps the day as it goes
 *  so a slow or failing run can't become a retry loop on every reload. */
export function claimDailyDraftRun(storage = window.localStorage, today = todayYMD()) {
  try {
    if (storage.getItem(DRAFT_RUN_KEY) === today) return false
    storage.setItem(DRAFT_RUN_KEY, today)
    return true
  } catch {
    // Private mode or blocked storage: don't fire at all rather than fire on
    // every single page load.
    return false
  }
}

/** "2m ago" / "3h ago" for a proposal's created_at. The backend stamps naive
 *  UTC (isoformat without a zone), so assume UTC when no offset is present. */
export function relTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
    const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
    if (s < 60) return 'just now'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch { return '' }
}

/** Only a drafted message is editable — see services/proposals.EDITABLE_FIELDS,
 *  which is the server-side authority; this just decides what to render. */
const isMessage = (p) => p?.kind === 'send_sms' && typeof p?.payload?.body === 'string'

function ProposalRow({ p, busy, error, onApprove, onDismiss }) {
  const agent = p.agent_id ? p.agent_id.charAt(0).toUpperCase() + p.agent_id.slice(1) : 'Autopilot'
  const editable = isMessage(p)
  const [draft, setDraft] = useState(editable ? p.payload.body : '')
  const original = editable ? p.payload.body : ''
  const edited = editable && draft.trim() !== original.trim()
  const empty = editable && !draft.trim()

  return (
    <div className="px-3.5 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <p className="text-[11px] text-ink-3">
            {agent} {editable ? 'drafted' : 'proposes'}
            {p.created_at && <span className="tabular-nums"> · {relTime(p.created_at)}</span>}
            {edited && <span> · edited</span>}
          </p>
          <p className="mt-0.5 text-[13px] font-semibold leading-snug text-ink">{p.title}</p>
          {p.detail && <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{p.detail}</p>}
          {error && (
            <p className="mt-1 text-[12px] font-medium text-rose-600 dark:text-rose-400">Failed: {error}</p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pt-0.5">
          {error ? (
            /* Execution failed — the human should read the error, not retry
               blindly. The row stays; the primary is replaced by a dead label. */
            <span className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-rose-600 opacity-60 dark:text-rose-400">
              Failed
            </span>
          ) : (
            <>
              <button onClick={() => onDismiss(p)} disabled={!!busy}
                className="inline-flex h-8 items-center rounded-md border border-hairline-2 bg-panel px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
                Dismiss
              </button>
              <button onClick={() => onApprove(p, editable ? draft.trim() : null)}
                disabled={!!busy || empty}
                title={empty ? 'Write a message first' : undefined}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60">
                {busy === 'approve' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editable ? 'Send it' : 'Approve'}
              </button>
            </>
          )}
        </div>
      </div>

      {editable && !error && (
        /* The draft itself. A plain bordered field, not a tinted "AI card" —
           it's a message she's about to send, so it should look like one. */
        <label className="mt-2 block">
          <span className="sr-only">Message to send</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!!busy}
            rows={3}
            data-testid={`proposal-body-${p.id}`}
            className="w-full resize-y rounded-lg border border-hairline bg-bg px-2.5 py-2 text-[13px] leading-snug text-ink-2 outline-none transition-colors focus:border-hairline-2 disabled:opacity-60"
          />
        </label>
      )}
    </div>
  )
}

export default function ProposalsQueue() {
  const [proposals, setProposals] = useState([])
  const [busy, setBusy] = useState(null)        // { id, action: 'approve'|'dismiss' }
  const [failures, setFailures] = useState({})  // id -> result.error from a failed execution
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    try {
      const res = await get('/api/ai/proposals?status=pending')
      if (Array.isArray(res) && alive.current) setProposals(res)
    } catch { /* quiet — render nothing rather than an error state */ }
  }, [])

  useEffect(() => {
    // Draft the day's follow-ups first (once per day, no-op when the owner has
    // switched it off in Settings), then list. Deliberately sequential: listing
    // first would show a queue that's about to grow, which reads as a bug.
    let cancelled = false
    const run = async () => {
      if (claimDailyDraftRun()) {
        try { await post(DRAFT_URL) } catch { /* drafting is a bonus, not the queue */ }
      }
      if (!cancelled) load()
    }
    run()
    return () => { cancelled = true }
  }, [load])

  const approve = useCallback(async (p, editedBody) => {
    setBusy({ id: p.id, action: 'approve' })
    try {
      // Save the edit BEFORE approving: approve executes immediately, so a
      // send that raced the save would go out with the words she replaced.
      if (editedBody != null && editedBody !== (p.payload?.body || '').trim()) {
        await patch(`/api/ai/proposals/${p.id}`, { payload: { body: editedBody } })
      }
      const res = await post(`/api/ai/proposals/${p.id}/approve`)
      if (res?.status === 'executed') {
        pushToast(`Sent — ${p.title}`, 'success')
        setProposals(prev => prev.filter(x => x.id !== p.id))
        load()
      } else {
        // status 'failed': keep the row visible with the error. No refetch —
        // the proposal is no longer pending server-side and would vanish.
        setFailures(prev => ({ ...prev, [p.id]: res?.result?.error || 'The action could not be completed.' }))
      }
    } catch (e) {
      if (e?.status === 409) { pushToast('Already decided', 'info'); load() }
      else pushToast(e?.message || 'Approve failed — nothing was changed.', 'error')
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [load])

  const dismiss = useCallback(async (p) => {
    setBusy({ id: p.id, action: 'dismiss' })
    try {
      await post(`/api/ai/proposals/${p.id}/dismiss`)
      pushToast('Dismissed', 'info')
      setProposals(prev => prev.filter(x => x.id !== p.id))
      load()
    } catch (e) {
      if (e?.status === 409) { pushToast('Already decided', 'info'); load() }
      else pushToast(e?.message || 'Dismiss failed — nothing was changed.', 'error')
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [load])

  // An empty queue renders nothing at all: a permanent "no proposals" box is
  // exactly the kind of dead space the board was just cleared of.
  if (!proposals.length) return null
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
        <h2 className="text-[11px] font-medium text-ink-3">Waiting for your approval</h2>
        {/* Plain number, not a count bubble (owner veto). */}
        <span className="ml-auto text-[11px] font-semibold tabular-nums text-ink-3">
          {proposals.length}
        </span>
      </header>
      <div className="divide-y divide-hairline">
        {proposals.map(p => (
          <ProposalRow key={p.id} p={p}
            busy={busy?.id === p.id ? busy.action : null}
            error={failures[p.id]}
            onApprove={approve} onDismiss={dismiss} />
        ))}
      </div>
    </section>
  )
}
