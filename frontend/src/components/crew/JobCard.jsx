/**
 * Crew job card — the full detail card a cleaner sees for one job.
 *
 * Extracted from MyDay.jsx so EVERY crew surface renders the same card:
 * the Today list, the 2-week schedule list, and the month-view tap-through
 * sheet (CrewJobSheet). Handlers are all optional — pass none and the card
 * is a read-only detail view (address → maps deep-link still works).
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

export const SOFT = 'bg-panel rounded-xl border border-hairline shadow-glass-sm'

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
  const [open, setOpen] = useState(false)
  const areas = Array.isArray(template) ? template : []
  const total = areas.reduce((n, a) => n + (a.tasks?.length || 0), 0)
  if (!total) return null
  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <ClipboardList className="w-3.5 h-3.5 text-ink-3" /> Checklist
          <span className="text-ink-3">· {total} tasks</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {areas.map((a, i) => (
            <div key={i}>
              <div className="text-[11px] font-bold uppercase tracking-wide text-ink-3">{a.area}</div>
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
      )}
    </div>
  )
}

/** Copy `text` to the clipboard: navigator.clipboard where available (needs a
 *  secure context), else the old textarea/execCommand fallback. Resolves true
 *  on success. Credentials never leave the device — no logging, no URL. */
function copyToClipboard(text) {
  const legacy = () => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => legacy())
  }
  return Promise.resolve(legacy())
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
      <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3 flex items-center gap-1.5">
        <Wifi className="w-3.5 h-3.5" /> House WiFi
      </div>
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
      <div className="mt-3 rounded-xl border border-blue-300/60 bg-blue-500/5 p-2.5">
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
    <div className={`mt-3 rounded-lg border px-3 py-2 text-[12px] flex items-center justify-between gap-2 ${
      accepted
        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-300'
        : 'bg-amber-500/10 border-amber-500/20 text-amber-800 dark:text-amber-300'}`}>
      <span className="min-w-0">
        {accepted ? '✓ You accepted' : 'You declined — the office knows'}
        {!accepted && r.reason && <span className="italic"> · “{r.reason}”</span>}
      </span>
      <button onClick={() => setChanging(true)} disabled={busy}
        className="shrink-0 font-semibold underline underline-offset-2 opacity-80 hover:opacity-100">
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
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            <CheckCircle2 className="w-3 h-3" /> Done
          </span>
        ) : isTurnover && (
          <span className="shrink-0 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            Turnover
          </span>
        )}
      </div>

      {/* The unanswered ask lives at the TOP of the card, not buried under
          notes/checklist blocks (owner: "I don't see it to accept"). Once
          answered it collapses to the small chip, still up here. */}
      {!done && onRespond && (
        <RespondRow job={job} onRespond={onRespond} onDecline={onDecline} busy={busy} />
      )}

      {(job.client_name || (job.teammates && job.teammates.length > 0)) && (
        <div className="mt-2 space-y-1">
          {job.client_name && (
            <div className="text-[13px] text-ink-2 flex items-center gap-1.5 flex-wrap">
              <span className="text-ink-3">For</span> {job.client_name}
              {job.can_text_client && !done && onTextClient && (
                /* No raw numbers on crew phones (owner's updated call):
                   texts go out structured, from the business line, logged
                   where the office reads them. */
                <button onClick={onTextClient}
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 active:opacity-60">
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

      {job.turnover_line && (
        <div className="mt-3 rounded-lg bg-bg border border-hairline px-3 py-2 text-[13px] text-ink-2">
          {job.turnover_line}
        </div>
      )}

      {houseLine && (
        /* The house preview: type + structured specs, only what's on file.
           Heads the house cluster — access details, house notes, and the
           photos & notes sheet follow right below. Codes stay exactly where
           they were (visible on the card, the page's access convention). */
        <div className="mt-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-3">The house</div>
          <div className="mt-0.5 text-[13px] text-ink-2 flex items-start gap-1.5">
            <Home className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" />
            <span>{houseLine}</span>
          </div>
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

      {job.house_notes?.length > 0 && (
        /* Crew-sourced, office-shared house knowledge — "upstairs drain
           clogs". Rides the payload (and offline cache), newest first. */
        <div className="mt-3 rounded-lg bg-amber-500/5 border border-amber-500/20 px-3 py-2 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">House notes</div>
          {job.house_notes.map((n, i) => (
            <div key={i} className="text-[12px] text-ink-2">
              {n.body}{n.author_name && <span className="text-ink-3"> — {n.author_name}</span>}
            </div>
          ))}
        </div>
      )}

      {!job.open && job.property_id && !done && onHouseInfo && (
        <button onClick={onHouseInfo}
          className="mt-2 text-[12px] font-semibold text-blue-600 dark:text-blue-400 inline-flex items-center gap-1 active:opacity-60">
          <Home className="w-3.5 h-3.5" /> House photos &amp; notes ›
        </button>
      )}

      {job.notes && (
        /* What the office wrote on the job — the "dog in the yard" tier.
           Was silently missing from crew cards until Aug 2026. */
        <div className="mt-3 rounded-lg bg-blue-500/5 border border-blue-500/15 px-3 py-2 text-[12px] text-ink-2 whitespace-pre-wrap">
          <span className="font-semibold text-ink">From the office: </span>{job.notes}
        </div>
      )}

      <ChecklistBlock template={job.checklist_template} />

      {done && job.completion_note && (
        <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-[12px] text-ink-2">
          Your note: “{job.completion_note}”
        </div>
      )}

      {onClaim && (
        /* Open-jobs board (Phase 3): first tap wins server-side; access
           details and the customer's number unlock once it's theirs. */
        <div className="mt-3 border-t border-hairline pt-3">
          <button onClick={onClaim} disabled={busy}
            className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <Sparkles className="w-4 h-4" /> Claim this job
          </button>
          <p className="text-[10px] text-ink-3 mt-1.5 text-center">
            First come, first served{job.teammates?.length ? ` · you'd join ${job.teammates.join(', ')}` : ''}
          </p>
        </div>
      )}

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
