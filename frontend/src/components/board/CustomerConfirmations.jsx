/**
 * Customers who just confirmed their visit — the quiet half of the feed.
 *
 * These need nothing from the owner. The customer accepted the time she already
 * put on the calendar, and knowing that is worth one line; being asked to act on
 * it is not. So this is deliberately read-only and deliberately NOT in "Needs
 * you now" — reschedule *requests*, which do need a yes or no, stay there
 * (Schedule derives them from the week payload it already has).
 *
 * It had a home on the old Dashboard page as `dashboard/CustomerActivity`. That
 * page was cut in #726 and the component sat unimported until #1144 deleted it,
 * at which point `/api/jobs/recent-confirmations` had no UI at all. The owner
 * asked for it back on the board, so this is that component re-homed in the
 * board's own chrome rather than a new idea.
 *
 * ## Why it fetches itself instead of riding the board payload
 *
 * `brightbase-economy` rule 3 prefers riding an existing payload, and
 * /api/dashboard/board already carries six triage sections in one round trip,
 * so a seventh looks like the obvious fit. Two things argue the other way:
 *
 *  - `Job.customer_confirmed_at` has NO INDEX (`database/models.py:832`, and no
 *    migration adds one), so the query behind this is a filtered scan. Small at
 *    this data size, but the board payload loads on every visit to the busiest
 *    screen in the app, and this feed is empty most days.
 *  - The board already has the pattern for exactly this case. MarketplaceBoard
 *    and BenchDigest "fetch themselves, so both wait until scrolled to
 *    (WhenVisible)" — OpsBoard's own words. Below the fold, on demand, zero
 *    cost until someone looks.
 *
 * So: one fetch, only when scrolled to, no polling. If the index ever lands,
 * folding this into build_board becomes the better trade and this comment is
 * the note explaining what changed.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { get } from '../../api'
import { STATUS_DOT } from '../../theme/statusDots'

/** "3h ago" / "2d ago" — same shape the rest of the board uses for recency. */
function ago(iso) {
  if (!iso) return ''
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${Math.max(1, mins)}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

/** The visit they confirmed, as a day the owner can place at a glance. */
function whenLabel(date, time) {
  if (!date) return ''
  // Parsed as local noon, not midnight UTC: `new Date('2026-11-02')` is UTC
  // midnight, which renders as the day BEFORE anywhere west of Greenwich —
  // the repeat date bug this repo keeps re-learning (brightbase-frontend).
  const d = new Date(`${date}T12:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  if (!time) return day
  const [h, m] = String(time).split(':')
  const hour = Number(h)
  if (Number.isNaN(hour)) return day
  const ampm = hour >= 12 ? 'pm' : 'am'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${day} · ${h12}${m && m !== '00' ? `:${m}` : ''}${ampm}`
}

export default function CustomerConfirmations() {
  const [items, setItems] = useState(null)

  useEffect(() => {
    let cancelled = false
    get('/api/jobs/recent-confirmations')
      .then(d => { if (!cancelled) setItems(Array.isArray(d?.confirmations) ? d.confirmations : []) })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [])

  // Nothing to say, no box. An owner scanning the board should only stop where
  // there is something — the same rule MarketplaceBoard and BenchDigest follow.
  if (!items || items.length === 0) return null

  return (
    // Canonical Home box chrome: in-card dot+word header over hairline-divided
    // rows, so this reads as part of the board rather than a transplant.
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        {/* Indigo = informational, per the design language's colour meanings.
            Not amber: amber is "needs attention", and this explicitly doesn't. */}
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" aria-hidden="true" />
        <h2 className="text-[11px] font-medium text-ink-3">Customers confirmed</h2>
        <span className="text-[11px] text-ink-3">· nothing to do</span>
      </header>
      <ul className="divide-y divide-hairline">
        {items.map(c => (
          <li key={c.job_id} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
            <span className="flex min-w-0 items-start gap-1.5 text-[13px] text-ink-2">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT.ok}`}
                aria-hidden="true" />
              <span className="min-w-0">
                <span className="text-ink">{c.client_name || 'Someone'}</span>
                {' confirmed'}
                {whenLabel(c.scheduled_date, c.start_time) && (
                  <span className="text-ink-3">{` ${whenLabel(c.scheduled_date, c.start_time)}`}</span>
                )}
                {c.confirmed_at && <span className="text-ink-3">{` · ${ago(c.confirmed_at)}`}</span>}
              </span>
            </span>
            <Link to={`/jobs/${c.job_id}`}
              className="shrink-0 text-[12px] font-medium text-ink-3 underline underline-offset-2 hover:text-ink-2 bb-focus">
              Open
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
