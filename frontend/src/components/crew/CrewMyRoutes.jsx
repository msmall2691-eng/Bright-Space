/**
 * My routes — the standing work I've been offered, and the standing work I own.
 *
 * A route is a whole day of recurring houses at one price. Offered, never
 * assigned: the office can put a route in front of somebody, and only the tap
 * on this screen makes it theirs. That is the same control point as claiming a
 * job, and it is what keeps a subcontractor a subcontractor.
 *
 * SO THE OFFER LEADS. An offer sitting unread is a route the office thinks is
 * being considered and the sub has never seen; MyDay carries a light summary
 * for exactly that reason, and this screen is where the decision is made.
 *
 * You see the houses BEFORE you accept. Agreeing to "Tuesday, $400" without
 * knowing which four houses and how long they take is not agreeing to
 * anything, and this is a standing commitment — not one shift.
 *
 * REQUEST ECONOMY: one GET when this is opened; accept and decline each return
 * the updated route, so a decision costs one call and nothing polls.
 */
import { useCallback, useEffect, useState } from 'react'
import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`)
const hhmm = (t) => (t ? String(t).slice(0, 5) : null)

function Houses({ members }) {
  if (!members?.length) return null
  return (
    <ul className="mt-2 space-y-1">
      {members.map(m => (
        <li key={m.recurring_schedule_id}
          className="flex items-baseline justify-between gap-3 text-[13px]">
          <span className="min-w-0 truncate text-ink">{m.title}</span>
          <span className="shrink-0 text-ink-3">
            {hhmm(m.start_time) && hhmm(m.end_time)
              ? `${hhmm(m.start_time)}–${hhmm(m.end_time)}`
              : ''}
            {m.share != null && <span className="ml-2 text-ink-2">{money(m.share)}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

export default function CrewMyRoutes() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(null)

  const load = useCallback(() => {
    get('/api/crew/my-routes')
      .then(r => { setData(r); setError(false) })
      .catch(() => setError(true))
  }, [])
  useEffect(() => { load() }, [load])

  const decide = async (routeId, verb) => {
    setBusy(routeId)
    try {
      await post(`/api/crew/routes/${routeId}/${verb}`)
      toast.success(verb === 'accept'
        ? 'Yours — it’ll show up on your days from now on.'
        : 'Turned down. The office will hear.')
      load()
    } catch (e) {
      // The vetting refusal arrives as {message, missing}: say which part,
      // because "finish your file" on its own is the same as no message.
      const d = e?.detail
      toast.error(d?.missing?.length ? `${d.message} ${d.missing[0]}.`
        : (d?.message || d || e?.message || 'That didn’t go through'))
    } finally { setBusy(null) }
  }

  if (error) {
    return <p className="px-4 py-6 text-[13px] text-ink-3">
      Couldn’t load your routes just now. Nothing has changed.
    </p>
  }
  if (!data) {
    return <div className="mx-4 my-6 h-24 animate-pulse rounded-xl bg-bg-2" aria-hidden="true" />
  }
  if (!data.offered.length && !data.active.length) {
    return (
      <div className="px-4 py-6">
        <p className="text-[15px] font-medium text-ink">No routes yet.</p>
        <p className="mt-1 text-[13px] text-ink-3">
          A route is a whole day of regular houses at one price — the office offers
          one, and you decide. Until then, jobs come one at a time from the board.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4 px-4 py-4">
      {data.offered.map(r => (
        <div key={r.id} className="rounded-xl border border-hairline bg-panel p-4">
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            Offered to you
          </div>
          <h3 className="mt-1 text-[17px] font-semibold text-ink">{r.name}</h3>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Every {DAYS[r.day_of_week] || 'week'} · {r.member_count} house
            {r.member_count === 1 ? '' : 's'} · <span className="font-medium text-ink">
              {money(r.rate)}</span> a week
          </p>

          <Houses members={r.members} />

          <p className="mt-2 text-[12px] text-ink-3">
            Take it and these houses are yours every week at this price, until one
            of you hands it back.
          </p>

          <div className="mt-3 flex gap-2">
            <button type="button" disabled={busy === r.id}
              onClick={() => decide(r.id, 'accept')}
              className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-[15px] font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
              Take it
            </button>
            <button type="button" disabled={busy === r.id}
              onClick={() => decide(r.id, 'decline')}
              className="rounded-lg border border-hairline-2 bg-panel px-4 py-2.5 text-[15px] font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
              No thanks
            </button>
          </div>
        </div>
      ))}

      {data.active.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Your routes
          </h2>
          <div className="space-y-3">
            {data.active.map(r => (
              <div key={r.id} className="rounded-xl border border-hairline bg-panel p-4">
                <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                  Yours
                </div>
                <h3 className="mt-1 text-[15px] font-semibold text-ink">{r.name}</h3>
                <p className="mt-0.5 text-[13px] text-ink-2">
                  Every {DAYS[r.day_of_week] || 'week'} · {money(r.rate)} a week
                </p>
                <Houses members={r.members} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
