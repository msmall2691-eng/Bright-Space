/**
 * Payroll, subcontractor side (marketplace pivot Phase 3, migration 099).
 *
 * The Payroll page has two audiences that must not share a table. An employee
 * is paid hours × rate and exported to Square. A subcontractor is paid a flat
 * price they agreed to for a whole job, from the ledger this screen drives.
 * Keeping them apart is not a layout preference: a screen that shows a sub an
 * hourly total is a screen that argues they are an employee, and worker
 * classification is the thing this whole pivot turns on.
 *
 * THE FLOW, and why it has three steps instead of one:
 *   1. Generate — record what the period's completed marketplace work owes.
 *      Creates `due` rows. Idempotent, so pressing it twice is safe; the
 *      screen shows "earned" and "not yet recorded" side by side so pressing
 *      it is a legible act rather than a leap.
 *   2. Send — hand payouts to the configured rail. The manual rail returns a
 *      CSV and marks them SENT.
 *   3. Mark paid — a person asserting money actually left. Nothing else in
 *      the system sets that, because nothing else knows.
 *
 * REQUEST ECONOMY: one GET answers the whole screen (period totals, the
 * ledger, year-to-date, the rail). Every write returns enough to justify a
 * single refetch, and there is no polling.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Send, Check, Ban, RefreshCw } from 'lucide-react'
import { get, post } from '../../api'
import { toast } from '../../utils/toastBus'

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`

const STATE = {
  due: { dot: 'bg-amber-500', word: 'Due' },
  sent: { dot: 'bg-blue-500', word: 'Sent' },
  paid: { dot: 'bg-emerald-500', word: 'Paid' },
  void: { dot: 'bg-ink-3/40', word: 'Void' },
}

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Dot + word. No pills, no fills, no count bubbles. */
function Status({ status }) {
  const s = STATE[status] || STATE.void
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.word}
    </span>
  )
}

function Figure({ label, value, sub }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-lg font-semibold text-ink mt-0.5">{value}</div>
      {sub && <div className="text-[12px] text-ink-3 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function SubcontractorPayroll({ startDate, endDate, isAdmin }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [picked, setPicked] = useState(() => new Set())

  const load = useCallback(async () => {
    if (!startDate || !endDate) return
    setLoading(true); setError('')
    try {
      setData(await get(`/api/payroll/subcontractors?start_date=${startDate}&end_date=${endDate}`))
      setPicked(new Set())
    } catch (e) {
      setError(e?.detail || e?.message || String(e))
    }
    setLoading(false)
  }, [startDate, endDate])

  useEffect(() => { load() }, [load])

  const payouts = data?.payouts || []
  const due = useMemo(() => payouts.filter(p => p.status === 'due'), [payouts])
  const pickedDue = useMemo(() => due.filter(p => picked.has(p.id)), [due, picked])
  // Marking paid is the confirmation that a `sent` payout actually landed, so
  // the selection it acts on is everything selected that isn't already paid.
  const pickedUnpaid = useMemo(
    () => payouts.filter(p => picked.has(p.id) && p.status !== 'paid' && p.status !== 'void'),
    [payouts, picked])

  const toggle = (id) => setPicked(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const run = async (label, fn) => {
    setBusy(label)
    try {
      const r = await fn()
      await load()
      return r
    } catch (e) {
      toast.error(e?.detail || e?.message || 'That didn’t go through')
      return null
    } finally { setBusy('') }
  }

  const generate = () => run('generate', async () => {
    const r = await post('/api/payroll/subcontractors/payouts/generate',
      { start_date: startDate, end_date: endDate })
    toast.success(r.created
      ? `Recorded ${r.created} payout${r.created === 1 ? '' : 's'} · ${money(r.total)}`
      : 'Nothing new to record — this period is already on the ledger')
    return r
  })

  const send = () => run('send', async () => {
    const ids = pickedDue.map(p => p.id)
    const r = await post('/api/payroll/subcontractors/payouts/send', { payout_ids: ids })
    if (r.csv) downloadCsv(r.csv, `subcontractor_payouts_${startDate}_to_${endDate}.csv`)
    // Says SENT, deliberately — the rail handed over a list, it did not pay
    // anyone. "Mark paid" is where a person says the money left.
    toast.success(`${r.count} marked sent · ${money(r.total)} · CSV downloaded`)
    return r
  })

  const mark = (status) => run(status, async () => {
    const ids = pickedUnpaid.map(p => p.id)
    const r = await post('/api/payroll/subcontractors/payouts/mark',
      { payout_ids: ids, status })
    toast.success(`${r.updated} marked ${status}`)
    return r
  })

  if (loading && !data) {
    return <div className="h-40 animate-pulse rounded-xl bg-bg-2" aria-hidden="true" />
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-hairline bg-panel p-4 text-sm text-ink-2">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
        {error}
      </div>
    )
  }
  if (!data) return null

  const ytd = data.ytd || { subs: [], total: 0, outstanding: 0, year: '' }

  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          This period
        </h2>
        <div className="grid grid-cols-2 rounded-xl border border-hairline bg-panel sm:grid-cols-4">
          <Figure label="Earned" value={money(data.earned_total)}
            sub="Completed jobs at their agreed rate" />
          <Figure label="Not yet recorded" value={money(data.unrecorded_total)}
            sub={data.unrecorded.length
              ? `${data.unrecorded.length} job${data.unrecorded.length === 1 ? '' : 's'}`
              : 'All on the ledger'} />
          <Figure label="Owed" value={money(data.outstanding_total)} sub="Due or sent, not paid" />
          <Figure label="Paid" value={money(data.paid_total)} />
        </div>
      </section>

      {data.unmatched?.length > 0 && (
        /* Work done by a crew ID with no login behind it — the one case where
           nothing here can say who to pay. A sentence and a dot, not a banner. */
        <p className="flex items-start gap-1.5 text-[13px] text-ink-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span>
            {data.unmatched.length} job{data.unmatched.length === 1 ? '' : 's'} done by a crew ID
            with no account ({[...new Set(data.unmatched.map(u => u.cleaner_id))].join(', ')}) —
            link it to a person on the Staff page and they become payable.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && (
          <button type="button" onClick={generate}
            disabled={busy === 'generate' || data.unrecorded.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
            <RefreshCw className="h-4 w-4" />
            {data.unrecorded.length
              ? `Record ${money(data.unrecorded_total)} owed`
              : 'Nothing new to record'}
          </button>
        )}
        {isAdmin && pickedDue.length > 0 && (
          <button type="button" onClick={send} disabled={busy === 'send'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-4 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
            <Send className="h-4 w-4" /> Send {pickedDue.length} · {money(
              pickedDue.reduce((s, p) => s + p.amount, 0))}
          </button>
        )}
        {isAdmin && pickedUnpaid.length > 0 && (
          <>
            <button type="button" onClick={() => mark('paid')} disabled={busy === 'paid'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-4 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
              <Check className="h-4 w-4" /> Mark {pickedUnpaid.length} paid
            </button>
            <button type="button" onClick={() => mark('void')} disabled={busy === 'void'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-4 py-2 text-sm font-medium text-ink-3 transition-colors hover:bg-bg-2 disabled:opacity-50">
              <Ban className="h-4 w-4" /> Void
            </button>
          </>
        )}
        {data.rail && (
          <span className="text-[12px] text-ink-3">
            Paid by {data.rail.name === 'manual' ? 'hand, from a CSV' : data.rail.name}
          </span>
        )}
      </div>

      {data.unrecorded.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Not yet on the ledger
          </h2>
          <div className="overflow-hidden rounded-xl border border-hairline bg-panel">
            <table className="w-full text-[13px]">
              <tbody>
                {data.unrecorded.map(r => (
                  <tr key={`${r.user_id}-${r.job_id}`} className="border-b border-hairline/60 last:border-0">
                    <td className="px-4 py-2 text-ink">{r.name}</td>
                    <td className="px-4 py-2 text-ink-3">{r.memo}</td>
                    <td className="px-4 py-2 text-ink-3">{fmtDate(r.earned_on)}</td>
                    <td className="px-4 py-2 text-right text-ink">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Ledger
        </h2>
        {payouts.length === 0 ? (
          <p className="text-[13px] text-ink-3">
            Nothing recorded for this period yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-hairline bg-panel">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-ink-3">
                  {isAdmin && <th className="w-8 px-3 py-2" aria-label="Select" />}
                  <th className="px-3 py-2 text-left font-medium">Subcontractor</th>
                  <th className="px-3 py-2 text-left font-medium">For</th>
                  <th className="px-3 py-2 text-left font-medium">Worked</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map(p => (
                  <tr key={p.id} className="border-b border-hairline/60 last:border-0">
                    {isAdmin && (
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={picked.has(p.id)}
                          onChange={() => toggle(p.id)}
                          aria-label={`Select payout for ${p.name || p.cleaner_id}`}
                          className="h-3.5 w-3.5 rounded border-hairline-2" />
                      </td>
                    )}
                    <td className="px-3 py-2 text-ink">{p.name || p.cleaner_id}</td>
                    <td className="px-3 py-2 text-ink-3">{p.memo || '—'}</td>
                    <td className="px-3 py-2 text-ink-3">{fmtDate(p.earned_on)}</td>
                    <td className="px-3 py-2"><Status status={p.status} /></td>
                    <td className="px-3 py-2 text-right text-ink">{money(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          {ytd.year} year to date
        </h2>
        {ytd.subs.length === 0 ? (
          <p className="text-[13px] text-ink-3">No subcontractor payouts recorded this year.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-hairline bg-panel">
            <table className="w-full min-w-[420px] text-[13px]">
              <thead>
                <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-ink-3">
                  <th className="px-3 py-2 text-left font-medium">Subcontractor</th>
                  <th className="px-3 py-2 text-right font-medium">Jobs</th>
                  <th className="px-3 py-2 text-right font-medium">Paid</th>
                  <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {ytd.subs.map(s => (
                  <tr key={s.user_id} className="border-b border-hairline/60 last:border-0">
                    <td className="px-3 py-2 text-ink">
                      {s.name || s.cleaner_id}
                      {s.over_1099_threshold && (
                        /* Advisory. The filing decision is the accountant's;
                           this is here so January is not a surprise. */
                        <span className="ml-2 text-[11px] text-ink-3">1099</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-3">{s.jobs}</td>
                    <td className="px-3 py-2 text-right text-ink-3">{money(s.paid)}</td>
                    <td className="px-3 py-2 text-right text-ink-3">{money(s.outstanding)}</td>
                    <td className="px-3 py-2 text-right text-ink">{money(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[12px] text-ink-3">
          Grouped by when the work happened, not when the money moved — a
          January payment for December work belongs to December. A “1099” mark
          means that person has passed $600 this year.
        </p>
      </section>
    </div>
  )
}

/** The manual rail's CSV comes back in the response body, not as a file. */
function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
