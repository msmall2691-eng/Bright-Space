/**
 * The marketplace, on the home — the office's version of "what's waiting on me".
 *
 * The owner doesn't dispatch: jobs go to the bench, cleaners ask, she says yes.
 * So the home should lead with the two things that arrangement puts on her
 * plate and nothing else did:
 *
 *   - cleaners who have asked and are waiting on her yes (the approve queue),
 *   - jobs posted to the bench that nobody has claimed yet (at risk of going
 *     uncovered).
 *
 * It reads the SAME /api/marketplace the Marketplace hub reads (one fetch, no
 * polling — brightbase-economy), and it LINKS to that hub to act. It never
 * approves anything itself: answering a claim is the one enforced "a sub
 * requests, the office never assigns" path, and a second place to do it is a
 * second place to get worker classification wrong (brightbase-marketplace).
 *
 * RENDERS NOTHING WHEN THERE'S NOTHING WAITING. Marketplace-led, but not a
 * permanent box — an owner scanning the page should only stop where there is
 * something to do (design language, same rule as BenchDigest).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { get } from '../../api'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

export default function MarketplaceBoard() {
  const [data, setData] = useState(null)

  useEffect(() => {
    // One fetch. It changes as subs ask and the office answers — not by the
    // second — so a page load / refresh is enough; no polling. A 403 (viewer)
    // or any odd shape falls to null and the section renders nothing.
    get('/api/marketplace').then(setData).catch(() => setData(null))
  }, [])

  const waiting = data?.waiting || {}
  const peopleWaiting = waiting.people_waiting || 0
  const jobsWaiting = waiting.job_count || 0
  // Open offers with nobody on them yet = every open job minus the ones that
  // already have someone waiting. Those are the ones that quietly go uncovered.
  const openNoTaker = Math.max(0, (data?.open_job_count || 0) - jobsWaiting)

  const lines = []
  if (peopleWaiting > 0) {
    lines.push({
      key: 'waiting', dot: 'bg-amber-500', to: '/marketplace', label: 'Review',
      text: (
        <>
          {plural(peopleWaiting, 'cleaner', 'cleaners')} waiting on your yes
          {jobsWaiting ? <span className="text-ink-3"> · {plural(jobsWaiting, 'job', 'jobs')}</span> : null}
        </>
      ),
    })
  }
  if (openNoTaker > 0) {
    lines.push({
      key: 'open', dot: 'bg-violet-500', to: '/marketplace', label: 'Open jobs',
      text: <>{plural(openNoTaker, 'job', 'jobs')} open to the bench with nobody yet</>,
    })
  }

  if (!lines.length) return null

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        Marketplace
      </h2>
      <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-panel">
        {lines.map(l => (
          <li key={l.key} className="flex items-start justify-between gap-3 px-4 py-2.5">
            <span className="flex items-start gap-1.5 text-[13px] text-ink-2">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${l.dot}`} aria-hidden="true" />
              <span>{l.text}</span>
            </span>
            <Link to={l.to}
              className="shrink-0 text-[12px] font-medium text-ink-3 underline underline-offset-2 hover:text-ink-2">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
