/**
 * The Saturday window — staffing a week of guest changeovers as one batch
 * (marketplace pivot Phase 5, migration 101).
 *
 * Turnovers can't be a route: twelve on a July Saturday, two in October. So
 * they stay posted jobs — but posting them one at a time, each with its own
 * approval, is the office-is-the-bottleneck problem again on the busiest day
 * of the week.
 *
 * A window opens the whole day at once and then RAISES THE PRICE on whatever
 * nobody has taken. That ladder is the point of this screen: a turnover nobody
 * wants at $85 is a turnover somebody wants at $110, and finding that out on
 * Wednesday costs money while finding it out on Friday night costs the booking.
 *
 * SO "UNCOVERED" IS THE HEADLINE. The one thing an owner opens this for is
 * whether Saturday is a problem, and any layout that makes them do arithmetic
 * to find out is the wrong one. Everything else — the ladder position, the
 * exposure, the job list — is what you read after the answer is bad.
 *
 * The ladder runs itself off the daily turnover-coverage tick. The buttons
 * here are for going early, not for driving it by hand.
 */
import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, ChevronDown, TrendingUp, Ban, Plus, Trash2 } from 'lucide-react'
import { get, post, patch, del } from '../api'
import { PageHeader, SubNav } from '../components/ui'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`)

const STATE = {
  pending: { dot: 'bg-ink-3/40', word: 'Not posted yet' },
  open: { dot: 'bg-amber-500', word: 'On the board' },
  closed: { dot: 'bg-ink-3/40', word: 'Closed' },
}

const fmtDay = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

/** How Saturday is going, in one line. Dot + sentence, never a banner. */
function Coverage({ w }) {
  if (w.total === 0) {
    return <span className="text-[13px] text-ink-3">No turnovers on this day yet</span>
  }
  const done = w.uncovered === 0
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
        done ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
      {done
        ? `All ${w.total} covered`
        : `${w.uncovered} of ${w.total} still open`}
    </span>
  )
}

export default function Turnovers() {
  const [windows, setWindows] = useState(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      setWindows((await get('/api/turnover-windows')).windows)
      setError('')
    } catch (e) { setError(e?.detail || e?.message || String(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (label, fn) => {
    setBusy(label)
    try { await fn(); await load() }
    catch (e) { toast.error(e?.detail || e?.message || 'That didn’t go through') }
    finally { setBusy('') }
  }

  const create = async () => {
    // Default to the next Saturday — the changeover day this exists for.
    const d = new Date()
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7))
    const iso = window.prompt('Which day? (YYYY-MM-DD)', d.toISOString().slice(0, 10))
    if (!iso) return
    await run('create', async () => {
      const w = await post('/api/turnover-windows', { service_date: iso })
      setOpenId(w.id)
    })
  }

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Turnover windows"
        subtitle="Post a whole changeover day to the bench at once, and let the price climb on what's left."
        icon={CalendarClock}
        iconColor="amber"
      >
        <SubNav className="mb-3" />
        <button type="button" onClick={create} disabled={busy === 'create'}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
          <Plus className="h-4 w-4" /> Plan a day
        </button>
      </PageHeader>

      <div className="space-y-4 px-4 pb-6 sm:px-8">
        {error && (
          <p className="flex items-start gap-1.5 text-[13px] text-ink-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
            {error}
          </p>
        )}

        {windows === null ? (
          <div className="h-24 animate-pulse rounded-xl bg-bg-2" aria-hidden="true" />
        ) : windows.length === 0 ? (
          <div className="rounded-xl border border-hairline bg-panel p-6 text-[13px] text-ink-2">
            <p className="mb-1 font-medium text-ink">No windows planned.</p>
            <p className="text-ink-3">
              Plan a changeover day and its turnovers go on the board together, ten
              days out by default. Anything still unclaimed four days out starts
              getting more valuable, on its own, until somebody takes it or it hits
              the ceiling you set.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {windows.map(w => (
              <WindowCard key={w.id} w={w}
                open={openId === w.id}
                onToggle={() => setOpenId(openId === w.id ? null : w.id)}
                onRun={run} busy={busy} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function WindowCard({ w, open, onToggle, onRun, busy }) {
  const act = (verb) => onRun(verb, () => post(`/api/turnover-windows/${w.id}/${verb}`))

  const step = async () => {
    if (!await confirmDialog(
      `Everything still unclaimed goes from ${money(w.current_rate)} to `
      + `${money(w.current_rate * (1 + w.step_pct / 100))}. `
      + `${w.covered} job${w.covered === 1 ? '' : 's'} already taken won't change.`,
      { title: 'Raise the price now', confirmLabel: 'Raise it' })) return
    await act('step')
  }

  const close = async () => {
    if (!await confirmDialog(
      'The price stops climbing. Anything still unclaimed stays on the board at '
      + 'what it reached — somebody taking it late still beats nobody taking it.',
      { title: 'Stop bidding on this day', confirmLabel: 'Close window' })) return
    await act('close')
  }

  const remove = async () => {
    if (!await confirmDialog('It was never posted to anyone.',
      { title: 'Delete this window', confirmLabel: 'Delete', danger: true })) return
    await onRun('delete', () => del(`/api/turnover-windows/${w.id}`))
  }

  const s = STATE[w.status] || STATE.pending

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-panel">
      <button type="button" onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-2/60">
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{fmtDay(w.service_date)}</div>
          <div className="mt-0.5"><Coverage w={w} /></div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden items-center gap-1.5 text-[13px] text-ink-2 sm:inline-flex">
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
            {s.word}
          </span>
          <ChevronDown className={`h-4 w-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-hairline px-4 py-3">
          <Ladder w={w} onRun={onRun} />

          {w.jobs.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-hairline">
              <table className="w-full min-w-[420px] text-[13px]">
                <thead>
                  <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-ink-3">
                    <th className="px-3 py-1.5 text-left font-medium">Turnover</th>
                    <th className="px-3 py-1.5 text-left font-medium">Who</th>
                    <th className="px-3 py-1.5 text-right font-medium">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {w.jobs.map(j => (
                    <tr key={j.id} className="border-b border-hairline/60 last:border-0">
                      <td className="px-3 py-1.5 text-ink">
                        {j.start_time && (
                          <span className="mr-2 tabular-nums text-ink-3">
                            {j.start_time.slice(0, 5)}
                          </span>
                        )}
                        {j.title}
                      </td>
                      <td className="px-3 py-1.5">
                        {j.taken ? (
                          <span className="inline-flex items-center gap-1.5 text-ink-2">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                            {j.cleaner_ids.join(', ')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-ink-3">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                            Nobody yet
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right text-ink">
                        {money(j.taken ? j.agreed_rate : j.posted_rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {w.status !== 'closed' && (
              <button type="button" onClick={() => act('open')} disabled={!!busy}
                className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
                {w.status === 'open' ? 'Re-post anything new' : 'Post it now'}
              </button>
            )}
            {w.status === 'open' && !w.at_ceiling && w.uncovered > 0 && (
              <button type="button" onClick={step} disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
                <TrendingUp className="h-3.5 w-3.5" /> Raise it now
              </button>
            )}
            {w.status === 'open' && (
              <button type="button" onClick={close} disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-3 transition-colors hover:bg-bg-2 disabled:opacity-50">
                <Ban className="h-3.5 w-3.5" /> Stop bidding
              </button>
            )}
            {w.status === 'pending' && (
              <button type="button" onClick={remove} disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-3 transition-colors hover:bg-bg-2 disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The ladder: what it starts at, where it's got to, and where it stops.
 *
 * Editable inline, and edits deliberately do NOT reprice what's already on the
 * board — the number people are looking at is the number they'd claim against,
 * and moving it under them is how a claim gets made against a price that no
 * longer exists. Changes take effect at the next step; the copy says so.
 */
function Ladder({ w, onRun }) {
  const [base, setBase] = useState(w.base_rate ?? '')
  const [pct, setPct] = useState(w.step_pct ?? 10)
  const [cap, setCap] = useState(w.max_steps ?? 3)

  const commit = () => {
    const body = {}
    if (Number(base) !== Number(w.base_rate ?? 0)) body.base_rate = Number(base) || 0
    if (Number(pct) !== Number(w.step_pct)) body.step_pct = Number(pct)
    if (Number(cap) !== Number(w.max_steps)) body.max_steps = Number(cap)
    if (Object.keys(body).length) onRun('save', () => patch(`/api/turnover-windows/${w.id}`, body))
  }

  const ceiling = w.base_rate != null
    ? w.base_rate * (1 + (w.step_pct / 100) * w.max_steps) : null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="w-28">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-3">Starts at</span>
          <input type="number" step="any" value={base} onChange={e => setBase(e.target.value)}
            onBlur={commit}
            className="w-full rounded-lg border border-hairline bg-panel px-3 py-1.5 text-right text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-blue-400/30" />
        </label>
        <label className="w-24">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-3">Step %</span>
          <input type="number" step="any" value={pct} onChange={e => setPct(e.target.value)}
            onBlur={commit}
            className="w-full rounded-lg border border-hairline bg-panel px-3 py-1.5 text-right text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-blue-400/30" />
        </label>
        <label className="w-20">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-3">Max steps</span>
          <input type="number" value={cap} onChange={e => setCap(e.target.value)}
            onBlur={commit}
            className="w-full rounded-lg border border-hairline bg-panel px-3 py-1.5 text-right text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-blue-400/30" />
        </label>
      </div>

      <p className="text-[12px] text-ink-3">
        {w.base_rate == null ? (
          'No starting price set — posting this day will leave each turnover at whatever it already says.'
        ) : (
          <>
            Now at <span className="text-ink-2">{money(w.current_rate)}</span>
            {' '}(step {w.steps_taken} of {w.max_steps}) · climbs to at most{' '}
            <span className="text-ink-2">{money(ceiling)}</span>. Each step adds{' '}
            {w.step_pct}% of the starting price, not of the last one.
            {w.at_ceiling && ' At the ceiling — it won’t go higher on its own.'}
          </>
        )}
      </p>
      <p className="text-[12px] text-ink-3">
        {w.covered > 0 && <>{money(w.committed)} agreed so far. </>}
        {w.uncovered > 0 && <>{money(w.exposure)} more if the rest go at today’s price. </>}
        Opens {w.opens_on}, starts climbing {w.first_step_on}. Changing these
        won’t move a price already on the board — it takes effect at the next step.
      </p>
    </div>
  )
}
