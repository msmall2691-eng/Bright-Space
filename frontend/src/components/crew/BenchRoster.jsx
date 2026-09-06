/**
 * The bench: everyone who can work for you, and whether they actually can.
 *
 * Modelled on what Turno puts in front of a host — the person, their badges,
 * their history — because the alternative was what this app had: applications
 * in Settings > Users, document review nested in a disclosure on a staff row,
 * the weekly digest on the Ops Board. Three places, none of which answered
 * "who have I got".
 *
 * Grew out of the crew-files panel, which answered only the first half:
 *
 * The office's real question was never "is this one person cleared" — it's
 * "who still owes me something". Before this you could only ask it one person
 * at a time, by opening a disclosure on each row of the staff list. That's how
 * a certificate gets uploaded on a Tuesday and noticed in March.
 *
 * SO THE COUNTS LEAD, and they're the two that mean different things:
 *   · waiting for you — somebody has uploaded something and you haven't looked.
 *     This is YOUR queue and it's the only number with a task attached.
 *   · still owed — a hole in somebody's file. That's a message to send, not a
 *     button to press.
 * Anything that makes you count rows to tell those apart is the wrong shape.
 *
 * EXEMPT IS SHOWN, NOT HIDDEN. Crew who predate the gate can work today
 * without a complete file, and the row says both things at once: they're not
 * blocked, and they still owe you documents. Collapsing that into one green
 * tick is how an uninsured person ends up in a customer's house.
 *
 * WHAT THE WORK LINE DELIBERATELY DOES NOT SAY: nothing about declines, and
 * nothing about punctuality. The agreement they signed says declining a job is
 * free (section 2), and timing a contractor's arrival is supervision of hours.
 * Both are explained in services/bench.py — this is the screen that would make
 * either one tempting, so the reason lives next to the temptation.
 *
 * REQUEST ECONOMY: one GET draws the whole screen; accepting returns the
 * refreshed file so a decision costs one call, not two.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, FileCheck, X } from 'lucide-react'
import { download, get, post } from '../../api'
import { toast } from '../../utils/toastBus'

const DOC = {
  accepted: { dot: 'bg-emerald-500', word: 'accepted' },
  pending: { dot: 'bg-amber-500', word: 'waiting for you' },
  expired: { dot: 'bg-red-500', word: 'expired' },
  missing: { dot: 'bg-ink-3/40', word: 'not uploaded' },
}

const fmtDate = (iso) => {
  if (!iso) return null
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function CrewFiles() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(null)
  // Fetches with the Bearer token, then hands the blob to the browser. The
  // filename matters: these land in a downloads folder alongside other
  // people's tax forms.
  const viewDoc = async (userId, doc) => {
    try {
      await download(`/api/auth/users/${userId}/file/${doc.kind}/download`,
                     doc.filename || `${doc.kind}-${userId}`)
    } catch (e) {
      toast.error(e?.message || 'Could not open that document')
    }
  }


  const load = useCallback(() => {
    get('/api/crew/bench')
      .then(r => { setData(r); setError(false) })
      .catch(() => setError(true))
  }, [])
  useEffect(() => { load() }, [load])

  const review = async (userId, kind, status, extra = {}) => {
    setBusy(`${userId}:${kind}`)
    try {
      await post(`/api/auth/users/${userId}/file/${kind}/review`, { status, ...extra })
      load()
    } catch (e) {
      toast.error(e?.detail || e?.message || 'Could not save that')
    } finally { setBusy(null) }
  }

  const sendBack = async (userId, kind) => {
    // A rejection with no reason is a dead end for the person who has to fix
    // it, so the note is the prompt rather than an afterthought.
    const notes = window.prompt('What needs fixing? They see this.')
    if (notes == null) return
    await review(userId, kind, 'pending', { notes })
  }

  if (error) {
    return (
      <p className="text-[13px] text-ink-3">
        Couldn’t load crew files just now. Nothing has changed.
      </p>
    )
  }
  if (!data) return <div className="h-24 animate-pulse rounded-xl bg-bg-2" aria-hidden="true" />
  const people = data.people || []
  if (!people.length) return null

  const t = data.totals || {}
  const waiting = people.filter(c => c.awaiting_review.length)
  const owing = people.filter(c => !c.awaiting_review.length && !c.complete)
  const done = people.filter(c => c.complete)

  return (
    <div className="space-y-4">
      {/* The two counts that mean different things. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <span className={`h-1.5 w-1.5 rounded-full ${
            t.awaiting_review ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
          {t.awaiting_review
            ? `${t.awaiting_review} document${t.awaiting_review === 1 ? '' : 's'} waiting for you`
            : 'Nothing waiting for you'}
        </span>
        <span className="text-ink-3">
          {t.can_work} of {t.people} can take work
        </span>
        {t.incomplete > 0 && (
          <span className="text-ink-3">
            {t.incomplete} still {t.incomplete === 1 ? 'owes' : 'owe'} documents
          </span>
        )}
        {t.form_1099_due > 0 && (
          <span className="text-ink-3">
            {t.form_1099_due} over $600 this year
          </span>
        )}
      </div>

      {data.enforce_from && (
        <p className="flex items-start gap-1.5 text-[12px] text-ink-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3/40" aria-hidden="true" />
          <span>
            Crew who joined before {fmtDate(data.enforce_from)} can keep taking work while
            you collect their documents. Anyone added after needs a complete file first.
          </span>
        </p>
      )}

      {[['Waiting for you', waiting], ['Still owed', owing], ['Complete', done]]
        .filter(([, list]) => list.length)
        .map(([heading, list]) => (
          <section key={heading}>
            <h3 className="mb-1.5 text-[10px] uppercase tracking-wide text-ink-3">
              {heading}
            </h3>
            <div className="divide-y divide-hairline rounded-lg border border-hairline">
              {list.map(person => (
                <Person key={person.user_id} person={person} busy={busy}
                  onView={(doc) => viewDoc(person.user_id, doc)}
                  onAccept={(kind) => review(person.user_id, kind, 'accepted')}
                  onSendBack={(kind) => sendBack(person.user_id, kind)} />
              ))}
            </div>
          </section>
        ))}
    </div>
  )
}

function Person({ person, busy, onAccept, onSendBack, onView }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[14px] font-medium text-ink">{person.name}</span>
        <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
          <span className={`h-1.5 w-1.5 rounded-full ${
            person.complete ? 'bg-emerald-500'
              : person.can_work ? 'bg-blue-500' : 'bg-amber-500'}`} aria-hidden="true" />
          {person.complete ? 'File complete'
            : person.can_work ? 'Working while you collect their file'
              : 'Can’t take work yet'}
        </span>
      </div>

      <WorkLine person={person} />

      {person.missing.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {person.missing.map(m => (
            <li key={m} className="text-[12px] text-ink-3">{m}</li>
          ))}
        </ul>
      )}

      {person.documents.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {person.documents.map(doc => {
            const state = DOC[doc.status] || DOC.missing
            const key = `${person.user_id}:${doc.kind}`
            return (
              <div key={doc.kind}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.dot}`} aria-hidden="true" />
                  {doc.label} · {state.word}
                  {doc.expires_at && ` · ${doc.status === 'expired' ? 'expired' : 'good until'} ${fmtDate(doc.expires_at)}`}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {/* Opens in a tab rather than downloading: the job is to read
                      the certificate and check its dates, not to collect a
                      folder of other people's tax forms. */}
                  {/* download(), not <a href>: a new tab sends no Authorization
                      header, so this was a 401 in a blank tab. */}
                  <button type="button"
                    onClick={() => onView(doc)}
                    className="inline-flex items-center gap-1 rounded-md border border-hairline-2 bg-panel px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-bg-2">
                    <ExternalLink className="h-3 w-3" /> View
                  </button>
                  {doc.status !== 'accepted' && (
                    <button type="button" disabled={busy === key}
                      onClick={() => onAccept(doc.kind)}
                      className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
                      <Check className="h-3 w-3" /> Accept
                    </button>
                  )}
                  <button type="button" disabled={busy === key}
                    onClick={() => onSendBack(doc.kind)}
                    className="inline-flex items-center gap-1 rounded-md border border-hairline-2 bg-panel px-2 py-1 text-[11px] font-medium text-ink-3 transition-colors hover:bg-bg-2 disabled:opacity-50">
                    <X className="h-3 w-3" /> Send back
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** What they've actually done, in plain numbers.
 *
 * Outcome-shaped on purpose. "12 jobs, 11 finished on the day" is something a
 * customer of a business may fairly look at; "arrived 6 minutes late twice"
 * is a supervisor looking at an employee's hours, and that difference is the
 * whole classification argument (see services/bench.py).
 *
 * "on the day" is a count beside the total, never a lone percentage — 1 of 1
 * is 100% and tells you nothing about a person who has done one job.
 */
function WorkLine({ person }) {
  const w = person.work || {}
  const bits = []
  if (w.completed) {
    bits.push(`${w.completed} ${w.completed === 1 ? 'job' : 'jobs'} in the last ${w.history_days} days`)
    bits.push(`${w.on_day} finished on the day`)
  }
  if (w.upcoming) bits.push(`${w.upcoming} coming up`)
  if (w.pending_requests) {
    bits.push(`${w.pending_requests} ${w.pending_requests === 1 ? 'job' : 'jobs'} asked for`)
  }
  if (!bits.length && !person.paid_ytd) {
    return <p className="mt-1 text-[12px] text-ink-3">No work yet</p>
  }
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3">
      {bits.map((b, i) => (
        <span key={b}>{i > 0 && <span className="mr-2 text-ink-3/50">·</span>}{b}</span>
      ))}
      {person.paid_ytd > 0 && (
        <span>
          <span className="mr-2 text-ink-3/50">·</span>
          ${person.paid_ytd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} this year
        </span>
      )}
      {/* The 1099 you will owe them, surfaced in September rather than in
          January when it is a scramble. Amber dot = something to do, same
          vocabulary as everywhere else. */}
      {person.form_1099_due && (
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <span className="mr-1 text-ink-3/50">·</span>
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          1099 due
        </span>
      )}
    </p>
  )
}

export { FileCheck }
