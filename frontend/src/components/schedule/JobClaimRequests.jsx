/**
 * Who asked for this job, and at what price — the office side of the
 * marketplace (migration 097).
 *
 * The backend for this shipped in #758 with no UI at all: three endpoints
 * nobody could reach, so a sub could file a request and it would sit in the
 * database unseen. This is the screen that makes the pivot real.
 *
 * THE ONE DECISION THIS SCREEN EXISTS FOR is "who gets it", so the rows are
 * ordered to make that comparable at a glance: the name, what they want to be
 * paid, and what they said. A counter-offer reads as its own number against
 * the asking price rather than as a badge — she needs to see $95 next to $80
 * and decide, not decode a colour.
 *
 * Approving is the only primary action here (design language: one primary per
 * view). Decline is a quiet secondary, because declining one person is rarely
 * the thing you came to do — picking someone is, and picking someone declines
 * everyone else on its own.
 *
 * REQUEST ECONOMY: one GET, only for a job that has actually been posted (see
 * JobDetail's `postedEver` gate) — an ordinary job never pays for this. No
 * polling; the list refetches after a decision because a decision changes it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'

const money = (n) => n == null || n === '' ? null :
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/** Dot + word, per the design language — never a filled pill. */
const STATE = {
  pending: { dot: 'bg-amber-500', label: 'Waiting on you' },
  approved: { dot: 'bg-emerald-500', label: 'Approved' },
  declined: { dot: 'bg-ink-3/50', label: 'Declined' },
  withdrawn: { dot: 'bg-ink-3/50', label: 'Withdrawn' },
}

export default function JobClaimRequests({ jobId, postedRate, onDecided }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(() => {
    get(`/api/jobs/${jobId}/claim-requests`)
      .then(r => { setRows(r?.requests || []); setError(false) })
      .catch(() => setError(true))
  }, [jobId])

  useEffect(() => { load() }, [load])

  const decide = async (req, action) => {
    setBusyId(req.id)
    try {
      const r = await post(`/api/jobs/${jobId}/claim-requests/${req.id}/${action}`, {})
      toast.success(action === 'approve'
        ? `${req.cleaner_name} has the job${r?.agreed_rate ? ` at ${money(r.agreed_rate)}` : ''}`
        : `Declined ${req.cleaner_name}`)
      load()
      // Approving assigns the job and closes the offer, so the page around
      // this panel is now stale in ways this panel can't fix on its own.
      if (action === 'approve') onDecided?.()
    } catch (e) {
      // The server's message is the useful one — it names the actual blocker
      // (already double-booked that morning, no rate agreed, someone else got
      // there first). Replacing it with "could not approve" throws that away.
      toast.error(e?.detail || e?.message || 'Could not save that decision')
      load()
    } finally {
      setBusyId(null)
    }
  }

  if (error) {
    return (
      <div className="border-t border-hairline pt-3">
        <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">Job requests</div>
        <p className="text-[12px] text-ink-3">
          Couldn’t load the requests just now. Nothing has changed — reload to try again.
        </p>
      </div>
    )
  }

  if (rows === null) {
    return (
      <div className="border-t border-hairline pt-3" aria-hidden="true">
        <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">Job requests</div>
        <div className="h-10 animate-pulse rounded-lg bg-bg-2" />
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className="border-t border-hairline pt-3">
        <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">Job requests</div>
        <p className="text-[12px] text-ink-3">
          Nobody’s asked for this one yet. The crew sees it on their phones
          {postedRate ? ` at ${money(postedRate)}` : ' — set a rate so they know what it pays'}.
        </p>
      </div>
    )
  }

  const pending = rows.filter(r => r.status === 'pending')

  return (
    <div className="border-t border-hairline pt-3">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <div className="text-[10px] uppercase tracking-wide text-ink-3">Job requests</div>
        {/* Plain count in ink-3, never a bubble. */}
        <div className="text-[11px] text-ink-3">
          {pending.length ? `${pending.length} waiting` : 'All decided'}
          {postedRate ? ` · asking ${money(postedRate)}` : ''}
        </div>
      </div>

      <div className="space-y-1.5">
        {rows.map(req => {
          const state = STATE[req.status] || STATE.withdrawn
          // A null requested_rate means "I'll take your price" — say that in
          // words rather than showing an empty cell she has to interpret.
          const wants = req.requested_rate == null ? postedRate : req.requested_rate
          const countered = req.requested_rate != null && postedRate != null
            && Number(req.requested_rate) !== Number(postedRate)
          return (
            <div key={req.id}
              className="rounded-lg border border-hairline bg-panel px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[13px]">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state.dot}`} aria-hidden="true" />
                    <span className="font-medium text-ink truncate">{req.cleaner_name}</span>
                  </div>
                  <div className="text-[12px] text-ink-2 mt-0.5">
                    {wants != null ? (
                      <>
                        Wants <span className="font-medium text-ink">{money(wants)}</span>
                        {countered
                          ? <span className="text-ink-3"> · you asked {money(postedRate)}</span>
                          : req.requested_rate == null
                            ? <span className="text-ink-3"> · your asking price</span>
                            : null}
                      </>
                    ) : (
                      <span className="text-ink-3">No rate named</span>
                    )}
                  </div>
                  {req.message && (
                    <p className="text-[12px] text-ink-3 mt-1 whitespace-pre-line break-words">
                      “{req.message}”
                    </p>
                  )}
                  {/* What the office should weigh before handing this person
                      the job — approved time off over the date, or another job
                      at the same hour. Backend sends it only on rows still to
                      be decided, and only when there is something to say.

                      A LINE, NOT A BANNER. This is information for a decision
                      she is already making, not an alarm: same dot+word
                      vocabulary as the status above, amber because it wants a
                      second's thought, and it never disables Approve — the
                      time-off case is one she is allowed to say yes to, and
                      the app has no business overruling a subcontractor about
                      their own day. */}
                  {(req.heads_up || []).map((note, i) => (
                    <p key={i} className="flex items-start gap-1.5 text-[11px] text-ink-2 mt-1">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                      <span>{note}</span>
                    </p>
                  ))}
                  {req.status !== 'pending' && (
                    <div className="text-[11px] text-ink-3 mt-1">{state.label}</div>
                  )}
                </div>

                {req.status === 'pending' && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button type="button" disabled={busyId != null}
                      onClick={() => decide(req, 'decline')}
                      className="inline-flex items-center gap-1 rounded-md border border-hairline-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors">
                      <X className="w-3.5 h-3.5" /> Decline
                    </button>
                    <button type="button" disabled={busyId != null}
                      onClick={() => decide(req, 'approve')}
                      className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                      <Check className="w-3.5 h-3.5" />
                      {busyId === req.id ? 'Saving…' : 'Give it to them'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {pending.length > 1 && (
        <p className="text-[11px] text-ink-3 mt-1.5">
          Picking one turns the others down automatically — a job only goes to one person.
        </p>
      )}
    </div>
  )
}
