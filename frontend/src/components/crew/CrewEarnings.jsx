/**
 * What I'm owed — the sub's own payout ledger (BB-PAY-01).
 *
 * The ledger lived only on the office side; a sub could set up WHERE their
 * money goes but never see WHAT they had coming. This reads /api/crew/me/earnings
 * (their own rows only) and shows two quiet totals plus a short list.
 *
 * Per JOB, never by the hour — a subcontractor is paid per job (Rule 0), so
 * there is no hourly figure here to derive or show. Light payload, one fetch
 * (brightbase-economy).
 */
import { useEffect, useState } from 'react'
import { get } from '../../api'

const money = (n) => `$${Number(n || 0).toFixed(2)}`

// due = recorded but not sent; sent = on its way (e.g. a cheque); paid = landed.
// dot+word, never a pill (brightbase-design-language).
const STATUS = {
  due:  { dot: 'bg-ink-3',        word: 'Recorded' },
  sent: { dot: 'bg-indigo-500',   word: 'Sent' },
  paid: { dot: 'bg-emerald-500',  word: 'Paid' },
}

export default function CrewEarnings({ previewUserId = null }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let off = false
    const url = previewUserId != null
      ? `/api/crew/preview/${previewUserId}/me/earnings`
      : '/api/crew/me/earnings'
    get(url)
      .then(d => { if (!off) setData(d) })
      .catch(() => { if (!off) setData({ lines: [], paid: 0, pending: 0, count: 0 }) })
    return () => { off = true }
  }, [previewUserId])

  if (!data) return <p className="text-[12px] text-ink-3">Checking…</p>

  if (!data.count) {
    return (
      <p className="text-[12px] text-ink-3">
        Nothing on your ledger yet. Money you’re owed for jobs you’ve done shows
        up here.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {/* Two quiet numbers — plain ink, small ink-3 labels, hairline between. */}
      <div className="flex items-stretch">
        <div className="flex-1 pr-4">
          <div className="text-xl font-semibold text-ink tabular-nums">{money(data.pending)}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">Owed to you</div>
        </div>
        <div className="flex-1 pl-4 border-l border-hairline">
          <div className="text-xl font-semibold text-ink tabular-nums">{money(data.paid)}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">Paid so far</div>
        </div>
      </div>

      <ul className="divide-y divide-hairline">
        {data.lines.map((l, i) => {
          const s = STATUS[l.status] || STATUS.due
          return (
            <li key={i} className="flex items-center justify-between py-2 text-[12px]">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} aria-hidden="true" />
                <span className="text-ink-2 truncate">
                  {l.earned_on || '—'}
                  {l.memo ? <span className="text-ink-3"> · {l.memo}</span> : null}
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-ink-3">{s.word}</span>
                <span className="text-ink font-medium tabular-nums">{money(l.amount)}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
