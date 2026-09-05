/**
 * A subcontractor's vetting file, office side — accept, reject, fix a date.
 *
 * Reads the same `vetting_status` the crew's "My file" reads, so the two
 * screens cannot drift into disagreeing about whether somebody is cleared to
 * work. That matters more than it sounds: the office's answer is what stops
 * an uninsured person walking into a customer's house, and a second
 * implementation of "is this file good" is a second answer.
 *
 * REQUEST ECONOMY: nothing is fetched until this is OPENED. The staff list
 * renders every user at once, so a panel that loaded on mount would fire one
 * request per cleaner just to draw the page — fifteen calls to answer a
 * question nobody asked yet. The review POST returns the refreshed file, so a
 * decision costs one call, not two.
 *
 * The documents themselves open in a tab rather than downloading: the job is
 * to read the certificate and check its dates, not to collect a folder of
 * other people's tax forms.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, FileCheck, X } from 'lucide-react'
import { get, post } from '../api'
import { toast } from '../utils/toastBus'

const STATE = {
  accepted: { dot: 'bg-emerald-500', word: 'Accepted' },
  pending: { dot: 'bg-amber-500', word: 'Needs review' },
  expired: { dot: 'bg-red-500', word: 'Expired' },
  missing: { dot: 'bg-ink-3/40', word: 'Not uploaded' },
}

const fmtDate = (iso) => {
  if (!iso) return null
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function SubFileReview({ userId }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(null)

  const load = useCallback(() => {
    get(`/api/auth/users/${userId}/file`)
      .then(r => { setFile(r); setError(false) })
      .catch(() => setError(true))
  }, [userId])
  useEffect(() => { if (open && file === null) load() }, [open, file, load])

  const review = async (kind, status, extra = {}) => {
    setBusy(kind)
    try {
      setFile(await post(`/api/auth/users/${userId}/file/${kind}/review`, { status, ...extra }))
    } catch (e) {
      toast.error(e?.detail || e?.message || 'Could not save that')
    } finally { setBusy(null) }
  }

  const reject = async (kind) => {
    // A rejection with no reason is a dead end for the person who has to fix
    // it, so the note is the prompt rather than an afterthought.
    const notes = window.prompt('What needs fixing? They see this.')
    if (notes == null) return
    await review(kind, 'pending', { notes })
  }

  if (!open) {
    return (
      <div className="mt-3 border-t border-hairline pt-3">
        <button type="button" onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 transition-colors">
          <FileCheck className="w-3.5 h-3.5" /> Subcontractor file
        </button>
      </div>
    )
  }
  if (error) {
    return (
      <div className="mt-3 border-t border-hairline pt-3">
        <p className="text-[13px] text-ink-3">Couldn’t load this file just now. Nothing has changed.</p>
      </div>
    )
  }
  if (!file) {
    return <div className="mt-3 h-16 animate-pulse rounded-lg bg-bg-2" aria-hidden="true" />
  }

  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-ink-3">Subcontractor file</div>
        <div className="text-[12px] text-ink-2">
          {file.can_take_jobs ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Cleared to take jobs
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              {file.missing.length} thing{file.missing.length === 1 ? '' : 's'} outstanding
            </span>
          )}
        </div>
      </div>

      <p className="text-[12px] text-ink-3 mt-1">
        Agreement {file.agreement_accepted
          ? `signed (${file.agreement_version})`
          : 'not signed yet'}
      </p>

      <div className="mt-2 divide-y divide-hairline">
        {file.documents.map(doc => {
          const state = STATE[doc.status] || STATE.missing
          const uploaded = doc.status !== 'missing'
          return (
            <div key={doc.kind} className="py-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px]">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state.dot}`} aria-hidden="true" />
                  <span className="font-medium text-ink">{doc.label}</span>
                  {!doc.required && <span className="text-[11px] text-ink-3">optional</span>}
                </div>
                <div className="text-[12px] text-ink-3 mt-0.5">
                  {state.word}
                  {doc.expires_at && ` · ${doc.status === 'expired' ? 'expired' : 'good until'} ${fmtDate(doc.expires_at)}`}
                </div>
                {doc.notes && <p className="text-[12px] text-ink-2 mt-1">“{doc.notes}”</p>}
              </div>

              {uploaded && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <a href={`/api/auth/users/${userId}/file/${doc.kind}/download`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-hairline-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" /> View
                  </a>
                  {doc.status !== 'accepted' && (
                    <button type="button" disabled={busy === doc.kind}
                      onClick={() => review(doc.kind, 'accepted')}
                      className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                      <Check className="w-3.5 h-3.5" /> Accept
                    </button>
                  )}
                  <button type="button" disabled={busy === doc.kind}
                    onClick={() => reject(doc.kind)}
                    className="inline-flex items-center gap-1 rounded-md border border-hairline-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors">
                    <X className="w-3.5 h-3.5" /> Send back
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
