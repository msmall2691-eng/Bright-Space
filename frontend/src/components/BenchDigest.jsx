/**
 * This week on the bench — the same thing the Wednesday round-up sends.
 *
 * Everything the marketplace pivot added reports somewhere: payouts, vetting,
 * turnover windows, routes. Five screens, each of which has to be remembered
 * and opened. Nobody opens five screens on a Wednesday, so the parts that need
 * a decision get found on Friday, which is when they're expensive.
 *
 * This is the one place that asks for them together, and it comes from the
 * SAME function that builds the weekly push (services/bench_digest.py) — a
 * round-up that disagreed with the screen it links to would be worse than no
 * round-up.
 *
 * RENDERS NOTHING IN A QUIET WEEK. Not "all clear", not an empty panel with a
 * tick in it: nothing. An owner scanning a page should only stop where there
 * is something to do, and a permanent all-clear box trains people to skip the
 * spot where the real thing will appear.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { get } from '../api'

const LINKS = [
  { match: 'turnover', to: '/turnovers', label: 'Turnovers' },
  { match: 'route', to: '/routes', label: 'Routes' },
  { match: 'document', to: '/users', label: 'Staff files' },
  { match: 'owed', to: '/payroll', label: 'Payroll' },
  { match: '1099', to: '/payroll', label: 'Payroll' },
]

/** Where to go about this line. First match wins; the lines are written so the
 *  distinguishing word comes early enough for that to be right. */
const linkFor = (line) => LINKS.find(l => line.toLowerCase().includes(l.match))

export default function BenchDigest() {
  const [digest, setDigest] = useState(null)

  useEffect(() => {
    // One fetch, no polling. It changes on the timescale of days.
    get('/api/dashboard/bench').then(setDigest).catch(() => setDigest(null))
  }, [])

  // Guarded on the ARRAY, not on the `empty` flag. This sits on the Home
  // page: any response that isn't the shape expected — an older backend, a
  // proxy returning something odd — must render nothing rather than take the
  // whole page down with it.
  const lines = Array.isArray(digest?.lines) ? digest.lines : []
  if (!lines.length) return null

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        This week on the bench
      </h2>
      <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-panel">
        {lines.map((line, i) => {
          const link = linkFor(line)
          return (
            <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <span className="flex items-start gap-1.5 text-[13px] text-ink-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  aria-hidden="true" />
                <span>{line}</span>
              </span>
              {link && (
                <Link to={link.to}
                  className="shrink-0 text-[12px] font-medium text-ink-3 underline underline-offset-2 hover:text-ink-2">
                  {link.label}
                </Link>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
