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
import { Check, FileText, FileUp, ShieldCheck } from 'lucide-react'
import { get, post, upload as uploadFile } from '../../api'
import { toast } from '../../utils/toastBus'
import { STATUS_DOT } from '../../theme/statusDots'

/** Dot + word, per the design language — never a filled pill. */
const STATE = {
  accepted: { dot: STATUS_DOT.ok, word: 'On file' },
  pending: { dot: STATUS_DOT.attention, word: 'Waiting on the office' },
  expired: { dot: STATUS_DOT.problem, word: 'Expired' },
  missing: { dot: 'bg-ink-3/40', word: 'Not uploaded' },
}

const fmtDate = (iso) => {
  if (!iso) return null
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function DocRow({ doc, busy, onUpload, onSetExpiry }) {
  const fileRef = useRef(null)
  const [expiry, setExpiry] = useState(doc.expires_at || '')
  const state = STATE[doc.status] || STATE.missing
  const uploaded = doc.status !== 'missing'
  // The expiry no longer blocks the upload — a sub in a driveway shouldn't have
  // to fight a date field to get the file on. They can add it at upload OR
  // after; vetting won't clear an expiring doc with no date, so the signal
  // isn't lost, it's just out of the way. `dateChanged` shows a Save after an
  // upload; `needsDate` is the gentle nudge once it's on but dateless.
  const dateChanged = doc.expires && expiry !== (doc.expires_at || '')
  const needsDate = doc.expires && uploaded && !doc.expires_at

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
        <button type="button" disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors">
          <FileUp className="w-3.5 h-3.5" />
          {doc.status === 'missing' ? 'Upload' : 'Replace'}
        </button>
      </div>

      {doc.expires && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="text-[12px] text-ink-3 shrink-0">Expires</span>
              <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)}
                className="rounded-lg border border-hairline bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:outline-hidden focus:border-blue-400" />
            </label>
            {/* Save the date on an already-uploaded doc without re-picking the
                file — the "add it after" half of upload-first. */}
            {uploaded && dateChanged && (
              <button type="button" disabled={busy}
                onClick={() => onSetExpiry(doc.kind, expiry)}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                <Check className="w-3.5 h-3.5" /> Save date
              </button>
            )}
          </div>
          {needsDate && !dateChanged && (
            <p className="mt-1 flex items-start gap-1.5 text-[11.5px] text-ink-3">
              <span className={`mt-[5px] w-1.5 h-1.5 rounded-full ${STATUS_DOT.attention} shrink-0`} aria-hidden="true" />
              <span>Add the date from the certificate so we know when to ask for the next one — it doesn’t hold anything else up.</span>
            </p>
          )}
        </div>
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

export default function CrewMyFile({ bare = false, previewUserId = null }) {
  const [file, setFile] = useState(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  // Office preview: read the NAMED cleaner's file through the read-only twin.
  // Uploads and signing are the cleaner's alone (the API refuses them from an
  // office role), so the write handlers below no-op in preview.
  const preview = previewUserId != null
  const fileUrl = preview ? `/api/crew/preview/${previewUserId}/my-file` : '/api/crew/my-file'
  const agreementUrl = preview
    ? `/api/crew/preview/${previewUserId}/my-file/agreement`
    : '/api/crew/my-file/agreement'

  const load = useCallback(() => {
    get(fileUrl)
      .then(r => { setFile(r); setError(false) })
      .catch(() => setError(true))
  }, [fileUrl])
  useEffect(() => { load() }, [load])

  const upload = async (kind, f, expiresAt) => {
    if (preview) return
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

  // Add/update the expiry on an already-uploaded doc — the "add it after" half
  // of upload-first, so the date never blocks getting the file on. JSON body,
  // so post() (not upload()); it returns the refreshed file.
  const setExpiry = async (kind, expiresAt) => {
    if (preview) return
    setBusy(true)
    try {
      setFile(await post(`/api/crew/my-file/${kind}/expiry`, { expires_at: expiresAt || null }))
      toast.success('Date saved')
    } catch (e) {
      toast.error(e?.detail || e?.message || 'Could not save the date')
    } finally { setBusy(false) }
  }

  // The agreement text, fetched only when they open it — it is ~8KB and most
  // visits to this screen are about a document, not the contract.
  const [agreement, setAgreement] = useState(null)
  const [readToEnd, setReadToEnd] = useState(false)
  const [openingAgreement, setOpeningAgreement] = useState(false)

  const openAgreement = async () => {
    setOpeningAgreement(true)
    try {
      setAgreement(await get(agreementUrl))
      setReadToEnd(false)
    } catch (e) {
      toast.error(e?.detail || e?.message || 'Could not open the agreement')
    } finally { setOpeningAgreement(false) }
  }

  // Enabled only once they have reached the bottom. Not friction for its own
  // sake: this is the document the whole contractor arrangement rests on, and
  // "I was never shown it" is the objection it exists to answer.
  const onScroll = (e) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setReadToEnd(true)
  }

  const signAgreement = async () => {
    if (!agreement || preview) return
    setBusy(true)
    try {
      // Echo the hash of what was actually rendered. The server refuses a
      // mismatch rather than recording a signature against text nobody saw.
      setFile(await post('/api/crew/my-file/agreement', { sha256: agreement.sha256 }))
      setAgreement(null)
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

  // A friendly first name for the welcome, from the signed-in cleaner. Skipped
  // in office preview (the viewer isn't the cleaner), so the greeting there is
  // just generic rather than wrong.
  let firstName = null
  if (!preview) {
    try {
      const u = JSON.parse(localStorage.getItem('brightbase_user') || '{}')
      firstName = (u.full_name || '').trim().split(/\s+/)[0] || null
    } catch { /* no name is fine */ }
  }

  // Onboarding progress — one step for the agreement plus each REQUIRED
  // document. Drives the "X of Y done" line + bar so a new cleaner sees how
  // close they are instead of a flat list of demands. Optional documents don't
  // count toward the gate, so they don't count here.
  const reqDocs = (file.documents || []).filter(d => d.required)
  const stepsTotal = reqDocs.length + 1
  const stepsDone = reqDocs.filter(d => d.status === 'accepted').length + (file.agreement_accepted ? 1 : 0)
  const pct = stepsTotal ? Math.round((stepsDone / stepsTotal) * 100) : 0

  const body = (
    <>
      {file.can_take_jobs ? (
        <div className="flex items-start gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0" />
          <div>
            <p className="text-[14px] font-semibold text-ink">You’re all set{firstName ? `, ${firstName}` : ''} 🎉</p>
            <p className="text-[12.5px] text-ink-2">
              Your file is complete — you can ask for jobs. We’ll give you a heads-up well before anything here needs renewing.
            </p>
          </div>
        </div>
      ) : file.override ? (
        // The office cleared them to work before the file is complete. Say so
        // warmly, and keep the remaining items below as a gentle to-do, not a
        // "you can't work yet" wall.
        <div className="flex items-start gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0" />
          <div>
            <p className="text-[14px] font-semibold text-ink">You’re cleared to take jobs{firstName ? `, ${firstName}` : ''} 🎉</p>
            <p className="text-[12.5px] text-ink-2">
              The office set you up to start — finish the few things below when you can so your file’s complete.
            </p>
            {file.missing.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {file.missing.map(m => (
                  <li key={m} className="flex items-start gap-1.5 text-[12.5px] text-ink-3">
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full ${STATUS_DOT.attention} shrink-0`} aria-hidden="true" />
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div>
          {/* Warm welcome + a sense of how close they are — the "a lot at the
              beginning" was a flat list of requirements with no encouragement
              and no progress. The steps themselves are unchanged. */}
          <p className="text-[15px] font-semibold text-ink">Welcome{firstName ? `, ${firstName}` : ''} 👋</p>
          <p className="mt-0.5 text-[12.5px] text-ink-2">
            A few quick things and you’re ready to take jobs — about five minutes, right from
            your phone. It’s what keeps you and the homeowners covered.
          </p>
          {stepsTotal > 0 && (
            <div className="mt-3" role="progressbar" aria-valuenow={stepsDone} aria-valuemin={0} aria-valuemax={stepsTotal}>
              <div className="flex items-center justify-between text-[11px] text-ink-3">
                <span>Getting set up</span>
                <span className="tabular-nums">{stepsDone} of {stepsTotal} done</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-2">
                <div className={`h-full rounded-full ${STATUS_DOT.ok} transition-all duration-500`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
          <p className="mt-3 text-[13px] font-medium text-ink">To start asking for jobs:</p>
          <ul className="mt-1.5 space-y-1">
            {file.missing.map((m, i) => (
              <li key={m} className="flex items-start gap-1.5 text-[13px] text-ink-2">
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full ${STATUS_DOT.attention} shrink-0`} aria-hidden="true" />
                <span>{i === 0 ? <><span className="font-medium text-ink">Next:</span> {m}</> : m}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!file.agreement_accepted && !agreement && (
        <button type="button" onClick={openAgreement} disabled={busy || openingAgreement}
          className="mt-3 w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
          <FileText className="w-4 h-4" />
          {openingAgreement ? 'Opening…' : 'Read the subcontractor agreement'}
        </button>
      )}

      {!file.agreement_accepted && agreement && (
        <div className="mt-3">
          <div onScroll={onScroll} data-testid="agreement-text"
            className="max-h-[52vh] overflow-y-auto rounded-lg border border-hairline bg-bg-2/40 p-3
                       text-[13px] leading-relaxed text-ink-2 whitespace-pre-wrap">
            {agreement.text}
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3">
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${readToEnd ? STATUS_DOT.ok : STATUS_DOT.attention}`}
              aria-hidden="true" />
            {readToEnd
              ? `Version ${agreement.version} — you've read to the end`
              : 'Scroll to the end to accept'}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={signAgreement} disabled={busy || !readToEnd}
              className="flex-1 text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
              <Check className="w-4 h-4" /> I agree
            </button>
            <button type="button" onClick={() => setAgreement(null)} disabled={busy}
              className="text-[13px] font-medium text-ink-3 px-3 py-2.5 rounded-lg hover:bg-bg-2 transition-colors">
              Not now
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 divide-y divide-hairline">
        {file.documents.map(d => (
          <DocRow key={d.kind} doc={d} busy={busy} onUpload={upload} onSetExpiry={setExpiry} />
        ))}
      </div>

      <p className="mt-3 text-[11px] text-ink-3">
        Your documents are only visible to the office.
      </p>
    </>
  )

  return bare ? body : <div className="bg-panel border border-hairline rounded-xl p-4">{body}</div>
}
