/**
 * Billed, paid out, and what's left — beside the box where the price is typed.
 *
 * The routes plan put it plainly: post a job without seeing its margin and the
 * margin is what you'll lose. Every price the marketplace pivot introduced was
 * typed into a field with no other number next to it.
 *
 * IT SAYS WHERE THE BILLED FIGURE CAME FROM, every time. A margin computed
 * from a guess and shown as confidently as one computed from an invoice is a
 * number somebody will price the next ten jobs against. The three sources are
 * not equally trustworthy and the sentence says which one it used.
 *
 * "We don't know what this bills" renders as exactly that, not as a blank and
 * not as a cheerful 100%.
 *
 * REQUEST ECONOMY: one fetch when the job is posted, and one more only when
 * the office actually types a different number to try it out.
 */
import { useEffect, useState } from 'react'
import { get } from '../../api'

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`)

const SOURCE = {
  invoice: 'from this job’s invoice',
  quote: 'from the accepted quote',
  history: 'what this house usually bills',
}

export default function JobMargin({ jobId, pay }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!jobId) return
    let alive = true
    const q = pay == null || pay === '' ? '' : `?pay=${encodeURIComponent(pay)}`
    get(`/api/jobs/${jobId}/margin${q}`)
      .then(d => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
    return () => { alive = false }
  }, [jobId, pay])

  if (!data) return null

  if (data.billed == null) {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-[11px] text-ink-3">
        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3/40" aria-hidden="true" />
        <span>
          No invoice or quote on this one, and no billing history at this house —
          so there’s nothing to measure the price against yet.
        </span>
      </p>
    )
  }
  if (data.pay == null) {
    return (
      <p className="mt-1 text-[11px] text-ink-3">
        Bills {money(data.billed)} ({SOURCE[data.billed_source]}).
      </p>
    )
  }

  const thin = data.margin_pct != null && data.margin_pct < 20
  const under = data.margin != null && data.margin < 0
  return (
    <p className="mt-1 flex items-start gap-1.5 text-[11px] text-ink-2">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
        under ? 'bg-red-500' : thin ? 'bg-amber-500' : 'bg-emerald-500'}`}
        aria-hidden="true" />
      <span>
        Bills {money(data.billed)} ({SOURCE[data.billed_source]}
        {data.billed_source === 'history' && data.billed_detail
          ? `, last ${data.billed_detail.visits}` : ''}),
        pays {money(data.pay)} — <span className="font-medium text-ink">
          {money(data.margin)}</span> left
        {data.margin_pct != null && `, ${data.margin_pct}%`}
        {under && ' — this one loses money'}.
      </span>
    </p>
  )
}
