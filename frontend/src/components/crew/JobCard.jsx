/**
 * Crew job card — the full detail card a cleaner sees for one job.
 *
 * Extracted from MyDay.jsx so EVERY crew surface renders the same card:
 * the Today list, the 2-week schedule list, and the month-view tap-through
 * sheet (CrewJobSheet). Handlers are all optional — pass none and the card
 * is a read-only detail view (address → maps deep-link still works).
 *
 * Reading order is the job's order of operations, standing at the door:
 * when → answer the ask → how do I get in (code, WiFi, what the office
 * flagged) → who's here → then the reference tiers (house details,
 * checklist) behind inline expanders. Nothing here fetches; expanding a
 * row just reveals payload the card already has.
 *
 * Data comes exclusively from /api/crew/* payloads (assigned-cleaner-only;
 * the office job endpoints never feed this card).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MapPin, KeyRound, ParkingCircle, ChevronDown, Navigation, CheckCircle2,
  Camera, Users, Phone, ClipboardList, Sparkles, Wifi, Home, Copy, Check,
  QrCode,
} from 'lucide-react'
import { wifiQrPayload, qrMatrix, qrSvgPath } from './wifiQr'
import { copyToClipboard } from '../../utils/clipboard'
import StatusBadge from '../ui/StatusBadge'
import { SOFT, SectionLabel, DisclosureRow } from './primitives'

export function fmtTimeRange(start, end) {
  if (!start && !end) return ''
  if (start && end) return `${start} – ${end}`
  return start || end
}

/** Directions deep-link for the phone's native maps app. iOS intercepts
 *  maps.apple.com into Apple Maps; everything else gets the Google Maps
 *  universal directions URL (opens the app on Android, the site on desktop). */
export function mapsUrl(address) {
  const q = encodeURIComponent(address)
  const ios = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)
  return ios
    ? `https://maps.apple.com/?daddr=${q}`
    : `https://www.google.com/maps/dir/?api=1&destination=${q}`
}

/** "Vacation rental · 3 bd · 2.5 ba · 1,850 sqft · built 1987" for the card's
 *  house preview — only fields on file, never dashes for unknowns. Null (no
 *  line at all) for a plain residential house with no specs recorded. */
const PROPERTY_TYPE_LABELS = { str: 'Vacation rental', commercial: 'Commercial', residential: 'Residential' }

function houseSpecsLine(job) {
  const parts = []
  if (job.bedrooms != null) parts.push(`${job.bedrooms} bd`)
  if (job.bathrooms != null) parts.push(`${job.bathrooms} ba`)
  if (job.square_footage != null) parts.push(`${Number(job.square_footage).toLocaleString()} sqft`)
  if (job.year_built != null) parts.push(`built ${job.year_built}`)
  const type = PROPERTY_TYPE_LABELS[job.property_type]
  if (parts.length === 0 && (!type || job.property_type === 'residential')) return null
  return [type, ...parts].filter(Boolean).join(' · ')
}

/** Read-only view of the property's cleaning checklist, collapsed behind a
 *  task count. Working the checklist stays part of completion, not this list. */
function ChecklistBlock({ template }) {
  const areas = Array.isArray(template) ? template : []
  const total = areas.reduce((n, a) => n + (a.tasks?.length || 0), 0)
  if (!total) return null
  return (
    <DisclosureRow icon={ClipboardList} label="Checklist" count={`${total} tasks`}>
      <div className="space-y-2">
        {areas.map((a, i) => (
          <div key={i}>
            <SectionLabel>{a.area}</SectionLabel>
            <ul className="mt-0.5 space-y-0.5">
              {(a.tasks || []).map((t, j) => (
                <li key={j} className="text-[13px] text-ink-2 flex items-start gap-1.5">
                  <span className="mt-[7px] w-1 h-1 rounded-full bg-ink-3 shrink-0" /> {t}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </DisclosureRow>
  )
}

/** One tappable WiFi credential row — the WHOLE row copies (gloved thumbs),
 *  with a quiet Copy affordance that flips to "Copied" for a moment. */
function CopyRow({ label, value, mono = false }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const doCopy = async () => {
    const ok = await copyToClipboard(value)
    if (!ok) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={doCopy}
      className="w-full min-h-11 flex items-center justify-between gap-3 text-left active:opacity-60">
      <span className="min-w-0 flex items-baseline gap-2">
        <span className="text-[11px] text-ink-3 w-16 shrink-0">{label}</span>
        <span className={`text-[13px] text-ink break-all ${mono ? 'font-mono' : 'font-semibold'}`}>
          {value}
        </span>
      </span>
      {copied ? (
        <span className="shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400">
          <Check className="w-3.5 h-3.5" /> Copied
        </span>
      ) : (
        <span className="shrink-0 inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 border border-hairline-2 rounded-md px-2 py-1">
          <Copy className="w-3.5 h-3.5" /> Copy
        </span>
      )}
    </button>
  )
}

/** House WiFi on the assigned-job card. Joining the customer's WiFi is the
 *  crew data-saver (and often the only connectivity at a rural house), so this
 *  is designed as the first move on arrival: one-tap copy for network and
 *  password, plus an optional QR a teammate's phone can scan to join.
 *  Everything is client-side from data the crew payload already served —
 *  credentials never enter URLs, logs, or push payloads. */
function WifiBlock({ ssid, password }) {
  const [showQr, setShowQr] = useState(false)
  // The QR is only computed when asked for (and memoized after that).
  const qr = useMemo(() => {
    if (!showQr) return null
    const payload = wifiQrPayload(ssid, password)
    return payload ? qrMatrix(payload) : null
  }, [showQr, ssid, password])
  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <SectionLabel className="flex items-center gap-1.5">
        <Wifi className="w-3.5 h-3.5" /> House WiFi
      </SectionLabel>
      <p className="text-[11px] text-ink-3 mt-0.5">
        Join the house WiFi before photos — it saves your data.
      </p>
      <div className="mt-1">
        <CopyRow label="Network" value={ssid} />
        {password && <CopyRow label="Password" value={password} mono />}
      </div>
      <button onClick={() => setShowQr(s => !s)}
        className="min-h-11 text-[12px] font-medium text-ink-2 underline underline-offset-2 inline-flex items-center gap-1.5 active:opacity-60">
        <QrCode className="w-3.5 h-3.5 text-ink-3" />
        {showQr ? 'Hide the QR' : 'Show a QR for a teammate'}
      </button>
      {showQr && (qr ? (
        <div className="flex flex-col items-start gap-1">
          {/* Always black-on-white: cameras need the contrast, themes don't
              apply to scannable codes. */}
          <svg viewBox={`0 0 ${qr.length + 8} ${qr.length + 8}`}
            className="w-44 h-44 rounded-lg border border-hairline"
            style={{ background: '#fff' }} shapeRendering="crispEdges"
            role="img" aria-label={`WiFi QR code for ${ssid}`}>
            <path d={qrSvgPath(qr)} transform="translate(4 4)" fill="#000" />
          </svg>
          <p className="text-[10px] text-ink-3">Teammates scan it with their camera to join.</p>
        </div>
      ) : (
        <p className="text-[11px] text-ink-3">Couldn't draw a QR — use the copy buttons above.</p>
      ))}
    </div>
  )
}

/** Accept / Can't-make-it on an assigned job (crew app Phase 2). An answer is
 *  a status the office sees — declining never takes the job off this list
 *  (the office decides the reassignment). Change is always allowed. */
function RespondRow({ job, onRespond, onDecline, busy }) {
  const [changing, setChanging] = useState(false)
  const r = job.my_response
  if (!r || changing) {
    return (
      <div className="mt-3 rounded-xl border border-hairline bg-bg p-2.5">
        <div className="text-[11px] font-semibold text-ink-2 mb-1.5">Can you make this job?</div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => { setChanging(false); onRespond('accepted') }} disabled={busy}
            className="text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Accept
          </button>
          <button onClick={() => { setChanging(false); onDecline() }} disabled={busy}
            className="text-[13px] font-semibold bg-panel border border-hairline text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2 rounded-lg transition-colors">
            Can't make it
          </button>
        </div>
      </div>
    )
  }
  const accepted = r.response === 'accepted'
  return (
    <div className="mt-3 flex items-center justify-between gap-2 text-[12px]">
      <span className="min-w-0 flex items-center gap-1.5">
        <StatusBadge status={accepted ? 'success' : 'warning'} className="shrink-0">
          {accepted ? 'You accepted' : 'You declined'}
        </StatusBadge>
        {!accepted && (
          <span className="text-ink-3 truncate">
            the office knows{r.reason ? ` · “${r.reason}”` : ''}
          </span>
        )}
      </span>
      <button onClick={() => setChanging(true)} disabled={busy}
        className="shrink-0 font-semibold text-ink-2 underline underline-offset-2 hover:text-ink">
        Change
      </button>
    </div>
  )
}

export default function JobCard({ job, clockable = false, activeEntry = null, onClockIn, onClockOut, onMarkDone, onPhotos, onRespond, onDecline, onClaim, onTextClient, onHouseInfo, busy = false }) {
  const isTurnover = job.job_type === 'str_turnover'
  const done = job.status === 'completed'
  const houseLine = houseSpecsLine(job)
  const isActiveJob = clockable && activeEntry && activeEntry.job_id === job.id
  const someoneElseActive = clockable && activeEntry && activeEntry.job_id !== job.id
  const houseNoteCount = job.house_notes?.length || 0
  const hasHouseSection = !!(houseLine || houseNoteCount > 0 || (!job.open && job.property_id && onHouseInfo))
  return (
    <div className={`${SOFT} p-4 ${isActiveJob ? 'ring-2 ring-emerald-500/60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-bold text-ink tabular-nums">
            {fmtTimeRange(job.start_time, job.end_time) || 'Time TBD'}
          </div>
          <div className="text-sm font-semibold text-ink mt-0.5 truncate">
            {job.property_name || job.title}
          </div>
          {job.address && (
            /* Tap → the phone's maps app with directions. Generous hit area on
               purpose: this is the most-used tap on the page from a car. */
            <a href={mapsUrl(job.address)} target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-600 dark:text-blue-400 mt-1 -mb-1 py-1 flex items-center gap-1 active:opacity-60">
              <MapPin className="w-3 h-3 shrink-0" />
              <span className="truncate underline decoration-blue-400/40 underline-offset-2">{job.address}</span>
              <Navigation className="w-3 h-3 shrink-0 opacity-70" />
            </a>
          )}
        </div>
        {done ? (
          <StatusBadge status="success" className="shrink-0">Done</StatusBadge>
        ) : isTurnover && (
          <StatusBadge status="info" className="shrink-0">Turnover</StatusBadge>
        )}
      </div>

      {done && job.completion_note && (
        <div className="mt-2 text-[12px] text-ink-3">Your note: “{job.completion_note}”</div>
      )}

      {/* The unanswered ask lives at the TOP of the card, not buried under
          notes/checklist blocks (owner: "I don't see it to accept"). Once
          answered it collapses to the small status chip, still up here. */}
      {!done && onRespond && (
        <RespondRow job={job} onRespond={onRespond} onDecline={onDecline} busy={busy} />
      )}

      {/* ── The get-in cluster, directly under the address: turnover window,
          door code, parking, WiFi, and what the office flagged. This is what
          a cleaner needs standing at the door — it never hides. ── */}

      {job.turnover_line && (
        <div className="mt-3 rounded-lg bg-bg border border-hairline px-3 py-2 text-[13px] text-ink-2">
          {job.turnover_line}
        </div>
      )}

      {!job.open && !job.access_notes && !job.house_code && !done && (
        /* Empty ≠ broken: tell them BEFORE they drive that no code is on
           file, so "how do I get in" gets asked from the driveway at home,
           not the doorstep. */
        <div className="mt-2 text-[11px] text-ink-3 flex items-start gap-1.5">
          <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          No access info on file — ask the office if you need a code.
        </div>
      )}

      {(job.access_notes || job.parking_notes || job.house_code) && (
        <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
          {job.house_code && !job.turnover_line?.includes(job.house_code) && (
            <div className="text-[13px] text-ink-2 flex items-start gap-1.5">
              <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> Code {job.house_code}
            </div>
          )}
          {job.access_notes && (
            <div className="text-[13px] text-ink-2 flex items-start gap-1.5">
              <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> {job.access_notes}
            </div>
          )}
          {job.parking_notes && (
            <div className="text-[13px] text-ink-2 flex items-start gap-1.5">
              <ParkingCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> {job.parking_notes}
            </div>
          )}
        </div>
      )}

      {job.wifi_ssid && (
        /* WiFi rides the offline cache — at a dead-zone house these
           credentials ARE the fix, and joining is the crew data-saver. */
        <WifiBlock ssid={job.wifi_ssid} password={job.wifi_password} />
      )}

      {job.notes && (
        /* What the office wrote on the job — the "dog in the yard" tier.
           Rides with the get-in cluster (it's need-to-know before the door,
           not house trivia). Quiet card + dot, not a colored banner. */
        <div className="mt-3 rounded-lg border border-hairline bg-bg px-3 py-2">
          <div className="text-[11px] font-semibold text-ink flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" aria-hidden="true" />
            From the office
          </div>
          <div className="mt-0.5 text-[12px] text-ink-2 whitespace-pre-wrap">{job.notes}</div>
        </div>
      )}

      {(job.client_name || (job.teammates && job.teammates.length > 0)) && (
        <div className="mt-3 space-y-1">
          {job.client_name && (
            <div className="text-[13px] text-ink-2 flex items-center gap-1.5 flex-wrap">
              <span className="text-ink-3">For</span> {job.client_name}
              {job.can_text_client && !done && onTextClient && (
                /* No raw numbers on crew phones (owner's updated call):
                   texts go out structured, from the business line, logged
                   where the office reads them. */
                <button onClick={onTextClient}
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2 py-0.5 hover:bg-bg-2 active:opacity-60 transition-colors">
                  <Phone className="w-3 h-3" /> Text client
                </button>
              )}
            </div>
          )}
          {job.teammates && job.teammates.length > 0 && (
            <div className="text-[13px] text-ink-2 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-ink-3 shrink-0" />
              With {job.teammates.join(', ')}
            </div>
          )}
        </div>
      )}

      {hasHouseSection && (
        /* Reference tier — specs, shared house notes, the photo gallery —
           behind one inline expander so the get-in cluster stays above the
           fold. Everything but the gallery is already in the payload. */
        <DisclosureRow icon={Home} label="About this house"
          count={houseNoteCount > 0 ? `${houseNoteCount} note${houseNoteCount > 1 ? 's' : ''}` : null}>
          <div className="space-y-3">
            {houseLine && (
              <div className="text-[13px] text-ink-2">{houseLine}</div>
            )}
            {houseNoteCount > 0 && (
              /* Crew-sourced, office-shared house knowledge — "upstairs drain
                 clogs". Rides the payload (and offline cache), newest first. */
              <div className="space-y-1">
                <SectionLabel>House notes</SectionLabel>
                {job.house_notes.map((n, i) => (
                  <div key={i} className="text-[12px] text-ink-2">
                    {n.body}{n.author_name && <span className="text-ink-3"> — {n.author_name}</span>}
                  </div>
                ))}
              </div>
            )}
            {!job.open && job.property_id && onHouseInfo && (
              <button onClick={onHouseInfo}
                className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 inline-flex items-center gap-1 active:opacity-60">
                <Camera className="w-3.5 h-3.5" /> House photos &amp; all notes ›
              </button>
            )}
          </div>
        </DisclosureRow>
      )}

      <ChecklistBlock template={job.checklist_template} />

      {onClaim && (() => {
        /* Open-jobs board. Since the marketplace pivot (migration 097) this
           is an ASK, not a claim: several people can want the same job and
           the office picks, so the button can't promise "it's yours". A sub
           who already asked sees their own standing request instead of a
           button that looks like it never worked. Access details and the
           customer's number still unlock only once it's actually theirs. */
        const mine = job.my_claim_request
        const rate = job.posted_rate
        const asked = mine?.requested_rate
        return (
          <div className="mt-3 border-t border-hairline pt-3">
            {rate != null && (
              <p className="text-[13px] text-ink-2 mb-2 text-center">
                Pays <span className="font-semibold text-ink">${Number(rate).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              </p>
            )}
            {mine?.status === 'pending' ? (
              <>
                <p className="flex items-center justify-center gap-1.5 text-[13px] text-ink-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                  You asked{asked != null ? ` for $${Number(asked).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''} — waiting to hear back
                </p>
                <button onClick={onClaim} disabled={busy}
                  className="mt-2 w-full text-[13px] font-medium bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2.5 rounded-lg transition-colors">
                  Change what I asked for
                </button>
              </>
            ) : (
              <>
                <button onClick={onClaim} disabled={busy}
                  className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
                  <Sparkles className="w-4 h-4" /> Ask for this job
                </button>
                <p className="text-[10px] text-ink-3 mt-1.5 text-center">
                  The office picks who gets it{job.teammates?.length ? ` · you'd join ${job.teammates.join(', ')}` : ''}
                </p>
              </>
            )}
          </div>
        )
      })()}

      {clockable && !done && (
        <div className="mt-3 border-t border-hairline pt-3 grid grid-cols-2 gap-2">
          {isActiveJob ? (
            <button onClick={onClockOut} disabled={busy}
              className="text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
              Clock out
            </button>
          ) : someoneElseActive ? (
            <button disabled title="Clock out of your current job first"
              className="text-[13px] font-medium bg-panel border border-hairline text-ink-3 py-2 rounded-lg cursor-not-allowed">
              Clock in
            </button>
          ) : (
            <button onClick={onClockIn} disabled={busy}
              className="text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
              Clock in
            </button>
          )}
          <button onClick={onMarkDone} disabled={busy}
            className="text-[13px] font-semibold bg-panel border border-hairline text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Mark done
          </button>
        </div>
      )}

      {clockable && done && isActiveJob && (
        /* Marked done but the punch is still open — keep clock-out reachable
           right on the card (the green header bar has it too). */
        <div className="mt-3 border-t border-hairline pt-3">
          <button onClick={onClockOut} disabled={busy}
            className="w-full text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
            Clock out
          </button>
        </div>
      )}

      {onPhotos && (
        /* Photos stay reachable after Mark done on purpose — "after" shots are
           usually taken on the way out the door. */
        <button onClick={onPhotos} disabled={busy}
          className="mt-2 w-full text-[12px] font-medium text-ink-3 hover:text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5 border border-dashed border-hairline">
          <Camera className="w-3.5 h-3.5" /> Photos
        </button>
      )}
    </div>
  )
}
