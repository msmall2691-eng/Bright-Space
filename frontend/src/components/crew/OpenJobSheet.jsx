import { CalendarDays, Clock, Users, Home, DollarSign, Lock, Sparkles, MapPin } from 'lucide-react'
import { Sheet } from './primitives'
import PropertyPhoto from '../PropertyPhoto'

/**
 * The details of a job that's up for grabs — what a cleaner needs to decide
 * whether to go for it, in one tap.
 *
 * brightbase-marketplace: since the owner's Oct 2026 decision an open offer
 * carries the house ADDRESS and PHOTO alongside town/size/rate, so a cleared
 * sub can judge the job and choose without asking the office. What still waits
 * until the job is theirs: the customer's NAME and the access details (gate
 * code, wifi, entry notes). The photo loads once, when this sheet opens (not on
 * every board card), from the gated crew endpoint — so it only ever reaches a
 * sub who could already see the offer.
 */
const SERVICE = {
  str_turnover: {
    label: 'Vacation rental turnover',
    blurb: 'Reset the place between guests: full clean, fresh linens made up, kitchen and baths detailed, trash out, staged tidy for the next check-in.',
  },
  deep_clean: {
    label: 'Deep clean',
    blurb: 'Top to bottom — baseboards, inside the oven and fridge, and the detail work and build-up a standard visit skips.',
  },
  move_out: {
    label: 'Move-out / move-in clean',
    blurb: 'An empty home cleaned throughout — inside cabinets, drawers and appliances, every surface, floor to ceiling.',
  },
  residential: {
    label: 'Home cleaning',
    blurb: 'A standard home clean — kitchen, bathrooms, floors, dusting and a tidy throughout.',
  },
}

function serviceFor(job) {
  const key = (job.job_type || '').toLowerCase()
  if (SERVICE[key]) return SERVICE[key]
  const t = (job.title || '').toLowerCase()
  if (t.includes('deep')) return SERVICE.deep_clean
  if (t.includes('move')) return SERVICE.move_out
  if (t.includes('turnover') || t.includes('rental')) return SERVICE.str_turnover
  return SERVICE.residential
}

function fmtDate(d) {
  if (!d) return null
  const dt = new Date(`${d}T00:00:00`)
  return Number.isNaN(dt.getTime()) ? d
    : dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
const hhmm = (v) => (v || '').slice(0, 5)
function fmtWindow(s, e) {
  if (!s) return 'Time TBD'
  return e ? `${hhmm(s)}–${hhmm(e)}` : hhmm(s)
}
function hoursBetween(s, e) {
  if (!s || !e) return null
  const [sh, sm] = s.split(':').map(Number)
  const [eh, em] = e.split(':').map(Number)
  const mins = (eh * 60 + em) - (sh * 60 + sm)
  if (!(mins > 0)) return null
  const h = Math.round((mins / 60) * 10) / 10
  return `${h} hr${h === 1 ? '' : 's'}`
}
function sizeLine(job) {
  const p = []
  if (job.bedrooms != null) p.push(`${job.bedrooms} bd`)
  if (job.bathrooms != null) p.push(`${job.bathrooms} ba`)
  if (job.square_footage != null) p.push(`${Number(job.square_footage).toLocaleString()} sqft`)
  return p.join(' · ') || null
}

function Fact({ icon: Icon, label, value }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-2.5 py-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
        <div className="text-[13.5px] text-ink">{value}</div>
      </div>
    </div>
  )
}

export default function OpenJobSheet({ job, onClose, onClaim, onAccept, busy = false }) {
  if (!job) return null
  const svc = serviceFor(job)
  const priced = job.posted_rate != null
  const instant = !!job.instant_claim
  const mine = job.my_claim_request
  const pending = mine && mine.status === 'pending'
  const hours = hoursBetween(job.start_time, job.end_time)
  const size = sizeLine(job)
  const propType = job.property_type
    ? String(job.property_type).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : null

  // One primary action, mirroring the card: claim on the spot when it's priced
  // and instant-claim is on, otherwise ask / make an offer (which opens the
  // existing claim form). The parent closes the sheet in these handlers.
  const act = () => { if (instant && priced) onAccept?.(); else onClaim?.() }
  const actLabel = instant && priced
    ? `Claim it — $${job.posted_rate}`
    : priced ? `Ask for this — $${job.posted_rate}` : 'Make an offer'

  return (
    <Sheet onClose={onClose} busy={busy} wide>
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-500" aria-hidden="true" /> Up for grabs
        </div>
        <h2 className="mt-1 text-[18px] font-bold leading-tight text-ink">{svc.label}</h2>
        {job.address ? (
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(job.address)}`}
            target="_blank" rel="noopener noreferrer"
            className="mt-0.5 flex items-center gap-1 text-[13px] text-blue-600 dark:text-blue-400 active:opacity-60">
            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="underline decoration-blue-400/40 underline-offset-2">{job.address}</span>
          </a>
        ) : job.area && (
          <div className="mt-0.5 flex items-center gap-1 text-[13px] text-ink-2">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" /> {job.area}
          </div>
        )}
      </div>

      {/* The house from the road, so a sub can size up the place before going
          for it. One fetch on open, cached a day; hides itself if there's no
          imagery or photos are off. Address/name text still wait until it's
          theirs — the picture is all the offer reveals. */}
      <PropertyPhoto url={`/api/crew/jobs/${job.id}/property-photo`}
        className="w-full h-40 rounded-xl object-cover border border-hairline" />

      <div className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-2/30 px-3">
        <Fact icon={CalendarDays} label="When"
          value={[fmtDate(job.scheduled_date), fmtWindow(job.start_time, job.end_time)].filter(Boolean).join(' · ')} />
        <Fact icon={Clock} label="About" value={hours ? `${hours} on site` : null} />
        <Fact icon={Home} label="The place" value={[propType, size].filter(Boolean).join(' · ') || null} />
        <Fact icon={Users} label="Crew" value={job.crew_size > 1 ? `${job.crew_size}-person job` : 'Solo job'} />
        <Fact icon={DollarSign} label="Pay"
          value={priced ? `$${job.posted_rate}${instant ? ' — yours if you claim it' : ' — asking price'}` : 'Name your price — the office confirms'} />
      </div>

      <div>
        <div className="text-[12px] font-semibold text-ink">What this is</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{svc.blurb}</p>
      </div>

      {/* The identity gate, said plainly — not a dead end, a "later". */}
      <div className="flex items-start gap-2 rounded-xl border border-hairline bg-panel px-3 py-2.5">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        <p className="text-[12px] leading-snug text-ink-2">
          The access details — gate code, wifi, entry notes — and the customer’s
          name unlock once this job is yours.
        </p>
      </div>

      {pending ? (
        <div className="rounded-xl border border-hairline bg-panel px-3 py-2.5 text-[13px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            You’ve asked for this{mine.requested_rate != null ? ` at $${mine.requested_rate}` : ''} — the office will confirm.
          </span>
        </div>
      ) : (
        <button type="button" onClick={act} disabled={busy}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60">
          <Sparkles className="h-4 w-4" aria-hidden="true" /> {actLabel}
        </button>
      )}
    </Sheet>
  )
}
