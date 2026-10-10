/**
 * My rentals — the Airbnbs the office designated ME to do the turnovers for.
 *
 * "I gave one of my cleaners an Airbnb, and they can see all the turnovers that
 * come in for it, organized." This is that screen: the cleaner's standing
 * rentals, each with its upcoming turnovers grouped underneath, so a new booking
 * shows up here without anyone assigning it by hand.
 *
 * Still an OFFER, never an assignment (brightbase-marketplace Rule 0): a turnover
 * they haven't taken reads "Offered to you" and a tap opens the job to accept;
 * one already theirs reads "Yours". ACCESS DETAILS aren't here — this is a
 * schedule, not a key ring; the gate code lives on the day-of job card, for a
 * turnover that's actually theirs.
 *
 * REQUEST ECONOMY: one GET when opened. Tapping a turnover reuses the job-detail
 * sheet MyDay already owns (onOpenJob), so nothing here re-fetches or polls.
 */
import { useCallback, useEffect, useState } from 'react'
import { get } from '../../api'
import { STATUS_DOT } from '../../theme/statusDots'

const hhmm = (t) => (t ? String(t).slice(0, 5) : null)
const money = (n) => (n == null ? null : `$${Number(n).toFixed(2)}`)

function dayLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function TurnoverRow({ t, prop, onOpenJob, onClaim }) {
  const mine = t.mine
  const asked = t.my_claim_request?.status === 'pending'
  const dot = mine ? STATUS_DOT.ok : STATUS_DOT.attention
  const word = mine ? 'Yours' : (t.claimable ? 'Offered to you' : 'Pending')
  const time = hhmm(t.start_time) && hhmm(t.end_time) ? `${hhmm(t.start_time)}–${hhmm(t.end_time)}` : ''
  const rate = money(mine ? t.agreed_rate ?? t.posted_rate : t.posted_rate)

  // A turnover already mine opens the full job card (assigned-only, so the
  // detail endpoint serves it). One still offered opens the CLAIM sheet — the
  // detail endpoint 404s a job that isn't yet theirs, and taking it must go
  // through the same request/approve path as any offer (offered, never
  // assigned). A synthesized job carries just what the claim sheet reads;
  // showing this house's name here is fine — they're its designated cleaner.
  const handle = () => {
    if (mine) { onOpenJob?.(t.job_id); return }
    if (t.claimable) {
      onClaim?.({
        id: t.job_id, posted_rate: t.posted_rate,
        property_name: prop?.name, scheduled_date: t.date,
        start_time: t.start_time, end_time: t.end_time,
        my_claim_request: t.my_claim_request,
      })
    }
  }
  const tappable = mine || t.claimable

  return (
    <button type="button" onClick={handle} disabled={!tappable}
      className={`flex w-full items-baseline justify-between gap-3 py-2 text-left ${tappable ? '' : 'cursor-default'}`}>
      <span className="min-w-0">
        <span className="text-[14px] font-medium text-ink">{dayLabel(t.date)}</span>
        {time && <span className="ml-2 text-[12px] text-ink-3">{time}</span>}
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-2">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
          {word}
          {asked && <span className="text-ink-3">· you asked</span>}
        </span>
      </span>
      {rate && <span className="shrink-0 text-[13px] tabular-nums text-ink-2">{rate}</span>}
    </button>
  )
}

export default function CrewMyProperties({ previewUserId = null, onOpenJob, onClaim }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)

  const preview = previewUserId != null
  const url = preview ? `/api/crew/preview/${previewUserId}/my-properties` : '/api/crew/my-properties'

  const load = useCallback(() => {
    get(url).then(r => { setData(r); setError(false) }).catch(() => setError(true))
  }, [url])
  useEffect(() => { load() }, [load])

  if (error) {
    return <p className="px-4 py-6 text-[13px] text-ink-3">
      Couldn’t load your rentals just now. Nothing has changed.
    </p>
  }
  if (!data) {
    return <div className="mx-4 my-6 h-24 animate-pulse rounded-xl bg-bg-2" aria-hidden="true" />
  }
  const props = data.properties || []
  if (!props.length) {
    return (
      <div className="px-4 py-6">
        <p className="text-[15px] font-medium text-ink">No rentals assigned to you.</p>
        <p className="mt-1 text-[13px] text-ink-3">
          When the office makes you a rental’s standing cleaner, every turnover that comes
          in for it shows up here — and you take each one with a tap.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4 px-4 py-4">
      {props.map(p => (
        <div key={p.property_id} className="rounded-xl border border-hairline bg-panel p-4">
          <h3 className="text-[16px] font-semibold text-ink">{p.name}</h3>
          {(p.city || p.state) && (
            <p className="mt-0.5 text-[12px] text-ink-3">
              {[p.city, p.state].filter(Boolean).join(', ')}
            </p>
          )}
          {p.turnovers.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-3">No upcoming turnovers.</p>
          ) : (
            <div className="mt-2 divide-y divide-hairline">
              {p.turnovers.map(t => (
                <TurnoverRow key={t.job_id} t={t} prop={p} onOpenJob={onOpenJob} onClaim={onClaim} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
