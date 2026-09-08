/**
 * My asks — every open job this sub has requested, and what happened to each.
 *
 * The gap this closes: once the office approves someone, the job leaves the
 * open board, so on the asking sub's phone the request simply vanished. A sub
 * who asked for four jobs on Tuesday had nothing on Friday telling them what
 * became of any of them — so they couldn't learn to bid, and couldn't tell
 * whether they were being ignored. This is their side of the ledger: pending
 * asks they can pull back, and decided ones (won / passed over / withdrawn).
 *
 * REQUEST ECONOMY: one GET when the section opens; a withdraw POST refetches
 * (brightbase-economy). Identity stays stripped server-side on any ask they
 * didn't win, exactly like the board.
 */
import { useCallback, useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'
import { EmptyState, ErrorState, Skeleton } from '../ui'

/** Dot + word, per the design language — never a filled pill. */
const STATE = {
  pending:   { dot: 'bg-amber-500',   word: 'Waiting to hear' },
  approved:  { dot: 'bg-emerald-500', word: 'You got it' },
  declined:  { dot: 'bg-ink-3/40',    word: 'Someone else got it' },
  withdrawn: { dot: 'bg-ink-3/40',    word: 'You pulled it back' },
}

const money = (n) => (n == null ? null : `$${Number(n).toFixed(0)}`)

const fmtDay = (iso) => {
  if (!iso) return null
  const d = new Date(`${iso}T12:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function CrewMyAsks() {
  const [claims, setClaims] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(() => {
    setLoading(true); setError(null)
    return get('/api/crew/my-claims')
      .then(d => setClaims(d?.claims || []))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const withdraw = useCallback(async (jobId) => {
    setBusyId(jobId)
    try {
      await post(`/api/crew/jobs/${jobId}/claim/withdraw`, {})
      toast.success('Pulled your request')
      await load()
    } catch (e) {
      // A 409 means it stopped being pending between render and tap (the
      // office just picked, or it was pulled elsewhere) — refetch to show why.
      toast.error(e.detail || e.message || 'Could not withdraw')
      if (e.status === 409) await load()
    } finally { setBusyId(null) }
  }, [load])

  if (loading) return <Skeleton className="h-16 w-full rounded-lg" />
  if (error) return <ErrorState onRetry={load} compact />
  if (!claims || claims.length === 0) {
    return (
      <EmptyState icon={Sparkles} compact
        title="You haven't asked for any jobs yet"
        description="Open jobs show up on Today — ask for one and it'll appear here." />
    )
  }

  return (
    <div className="space-y-2">
      {claims.map(c => {
        const st = STATE[c.status] || STATE.pending
        const rate = c.status === 'approved'
          ? c.agreed_rate : (c.requested_rate ?? c.posted_rate)
        const sub = [fmtDay(c.scheduled_date), c.area, money(rate)]
          .filter(Boolean).join(' · ')
        return (
          <div key={c.job_id} className="rounded-lg border border-hairline bg-panel px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[13px] text-ink truncate">
                  {c.title || c.area || `Job #${c.job_id}`}
                </div>
                {sub && <div className="text-[11px] text-ink-3 truncate">{sub}</div>}
              </div>
              <span className="flex items-center gap-1.5 text-[11px] text-ink-2 shrink-0">
                <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} aria-hidden="true" />
                {st.word}
              </span>
            </div>
            {c.status === 'pending' && (
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => withdraw(c.job_id)}
                  disabled={busyId === c.job_id}
                  className="text-[12px] font-medium text-ink-3 hover:text-ink-2 disabled:opacity-60">
                  {busyId === c.job_id ? 'Withdrawing…' : 'Withdraw'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
