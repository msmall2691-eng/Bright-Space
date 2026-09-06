/**
 * Who owes you a document, and what's sitting waiting for you to accept it.
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
 * REQUEST ECONOMY: one GET for the whole roster; accepting returns the
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
    get('/api/crew/files')
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
  if (!data.crew.length) return null

  const waiting = data.crew.filter(c => c.awaiting_review.length)
  const owing = data.crew.filter(c => !c.awaiting_review.length && !c.complete)
  const done = data.crew.filter(c => c.complete)

  return (
    <div className="space-y-4">
      {/* The two counts that mean different things. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <span className={`h-1.5 w-1.5 rounded-full ${
            data.awaiting_review ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
          {data.awaiting_review
            ? `${data.awaiting_review} document${data.awaiting_review === 1 ? '' : 's'} waiting for you`
            : 'Nothing waiting for you'}
        </span>
        {data.incomplete > 0 && (
          <span className="text-ink-3">
            {data.incomplete} {data.incomplete === 1 ? 'person' : 'people'} still owe documents
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
                  onAccept={(kind) => review(person.user_id, kind, 'accepted')}
                  onSendBack={(kind) => sendBack(person.user_id, kind)} />
              ))}
            </div>
          </section>
        ))}
    </div>
  )
}

function Person({ person, busy, onAccept, onSendBack }) {
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
                    onClick={() => viewDoc(person.user_id, doc)}
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

export { FileCheck }
