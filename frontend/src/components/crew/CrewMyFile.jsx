/**
 * My file — what the office has on record, and what's still in my way.
 *
 * A sub can't ask for a job until their file is complete: the agreement
 * signed, a W-9 on record, and a certificate of insurance that hasn't lapsed
 * (services/sub_vetting.py). Before this screen the refusal was a 403 with no
 * way to act on it — "finish your file" with nothing saying which part.
 *
 * So the missing pieces lead, in the order to do them, and each one is the
 * thing you tap. Everything else on the screen is reference.
 *
 * REQUEST ECONOMY: one GET when the section is opened, and one POST per
 * upload which returns the whole refreshed file — no refetch after a save, and
 * nothing polls. Uploads are the one place this screen is heavy, so the input
 * accepts a photo of a document rather than requiring a scan; a sub with a
 * phone in a driveway is the actual user.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, FileUp, ShieldCheck } from 'lucide-react'
import { get, post, upload as uploadFile } from '../../api'
import { toast } from '../../utils/toastBus'

/** Dot + word, per the design language — never a filled pill. */
const STATE = {
  accepted: { dot: 'bg-emerald-500', word: 'On file' },
  pending: { dot: 'bg-amber-500', word: 'Waiting on the office' },
  expired: { dot: 'bg-red-500', word: 'Expired' },
  missing: { dot: 'bg-ink-3/40', word: 'Not uploaded' },
}

const fmtDate = (iso) => {
  if (!iso) return null
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function DocRow({ doc, busy, onUpload }) {
  const fileRef = useRef(null)
  const [expiry, setExpiry] = useState(doc.expires_at || '')
  const state = STATE[doc.status] || STATE.missing
  // The server won't take a certificate without the date off it — it's how
  // the office knows when to ask for the next one — so the date is asked for
  // before the file picker opens rather than as a failed upload.
  const needsExpiry = doc.expires && !expiry

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state.dot}`} aria-hidden="true" />
            <span className="text-[14px] font-medium text-ink">{doc.label}</span>
            {!doc.required && <span className="text-[11px] text-ink-3">optional</span>}
          </div>
          <div className="text-[12px] text-ink-3 mt-0.5">
            {state.word}
            {doc.expires_at && doc.status !== 'missing' && ` · ${
              doc.status === 'expired' ? 'expired' : 'good until'} ${fmtDate(doc.expires_at)}`}
          </div>
          {doc.notes && (
            /* The office's reason for sending it back. Without it "rejected"
               is a dead end. */
            <p className="text-[12px] text-ink-2 mt-1">“{doc.notes}”</p>
          )}
        </div>
        <button type="button" disabled={busy || needsExpiry}
          onClick={() => fileRef.current?.click()}
          title={needsExpiry ? 'Add the expiry date first' : undefined}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors">
          <FileUp className="w-3.5 h-3.5" />
          {doc.status === 'missing' ? 'Upload' : 'Replace'}
        </button>
      </div>

      {doc.expires && (
        <label className="mt-2 flex items-center gap-2">
          <span className="text-[12px] text-ink-3 shrink-0">Expires</span>
          <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)}
            className="rounded-lg border border-hairline bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:outline-none focus:border-blue-400" />
        </label>
      )}

      <input ref={fileRef} type="file" className="hidden"
        accept="application/pdf,image/*"
        onChange={e => {
          const f = e.target.files?.[0]
          e.target.value = ''            // let the same file be picked twice
          if (f) onUpload(doc.kind, f, expiry)
        }} />
    </div>
  )
}

export default function CrewMyFile({ bare = false }) {
  const [file, setFile] = useState(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    get('/api/crew/my-file')
      .then(r => { setFile(r); setError(false) })
      .catch(() => setError(true))
  }, [])
  useEffect(() => { load() }, [load])

  const upload = async (kind, f, expiresAt) => {
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', f)
      if (expiresAt) form.append('expires_at', expiresAt)
      // uploadFile, NOT post: post() does JSON.stringify(body) and forces
      // Content-Type: application/json, and JSON.stringify(new FormData()) is
      // "{}" — so every W-9 and every certificate of insurance reached a
      // multipart endpoint as an empty JSON object and 422'd. Every time, for
      // everyone. can_take_jobs is derived from these documents, so nobody
      // recruited after the vetting gate could ever ask for a job.
      // The POST returns the refreshed file, so there's no second request to
      // find out what changed.
      setFile(await uploadFile(`/api/crew/my-file/${kind}`, form))
      toast.success('Sent to the office')
    } catch (e) {
      toast.error(e?.detail || e?.message || 'Could not upload that')
    } finally { setBusy(false) }
  }

  const signAgreement = async () => {
    setBusy(true)
    try {
      setFile(await post('/api/crew/my-file/agreement', {}))
      toast.success('Agreement signed')
    } catch (e) {
      toast.error(e?.detail || e?.message || 'Could not save that')
    } finally { setBusy(false) }
  }

  if (error) {
    return <p className="text-[13px] text-ink-3">
      Couldn’t load your file just now. Nothing has changed — pull down to try again.
    </p>
  }
  if (!file) {
    return <div className="h-20 animate-pulse rounded-lg bg-bg-2" aria-hidden="true" />
  }

  const body = (
    <>
      {file.can_take_jobs ? (
        <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
          Your file is complete — you can ask for jobs.
        </p>
      ) : (
        <div>
          <p className="text-[13px] font-medium text-ink">To start asking for jobs:</p>
          <ul className="mt-1.5 space-y-1">
            {file.missing.map(m => (
              <li key={m} className="flex items-start gap-1.5 text-[13px] text-ink-2">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!file.agreement_accepted && (
        <button type="button" onClick={signAgreement} disabled={busy}
          className="mt-3 w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
          <Check className="w-4 h-4" /> Sign the subcontractor agreement
        </button>
      )}

      <div className="mt-3 divide-y divide-hairline">
        {file.documents.map(d => (
          <DocRow key={d.kind} doc={d} busy={busy} onUpload={upload} />
        ))}
      </div>

      <p className="mt-3 text-[11px] text-ink-3">
        Your documents are only visible to the office.
      </p>
    </>
  )

  return bare ? body : <div className="bg-panel border border-hairline rounded-xl p-4">{body}</div>
}
