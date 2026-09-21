import { useState, useEffect, useRef } from 'react'
import { Wand2, Clock, Sparkles, Trash2 } from 'lucide-react'
import Button from '../ui/Button'
import Modal from '../ui/Modal'
import { get } from '../../api'

/** Two preview-then-confirm modals for the Tools menu, plus the price-before-post
 *  "open to crew" dialog. All accept parent-owned FSM state and onCancel + onRun
 *  handlers; the parent only mounts each while its state is set, so `open` is
 *  always true here. Built on the shared ui/Modal shell (focus-trap / Esc /
 *  scroll-lock / aria), dismiss gated while a run is in flight. */

export function AutoAssignModal({ state, onCancel, onRun, empName }) {
  if (!state) return null
  const assigned = state.preview?.assigned || []
  const unassignable = state.preview?.unassignable || []
  return (
    <Modal
      open
      onClose={onCancel}
      dismissable={!state.running}
      maxWidth="lg"
      ariaLabel="Auto-assign turnovers"
      title={
        <div className="flex items-center gap-2.5 min-w-0">
          <Wand2 className="w-5 h-5 text-indigo-600 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">Auto-assign turnovers</div>
            <div className="text-[12px] font-normal text-ink-3 mt-0.5">Available cleaners, balanced by daily load. Review before applying.</div>
          </div>
        </div>
      }
    >
      <Modal.Body className="space-y-3 scrollbar-thin">
        {state.loading ? (
          <div className="py-12 text-center text-[13px] text-ink-3">Finding available cleaners…</div>
        ) : (
          <>
            {assigned.length > 0 ? (
              <div className="space-y-1.5">
                {assigned.map(a => (
                  <div key={a.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{a.title}</div>
                      <div className="text-[11px] text-ink-3">{a.date}</div>
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2 shrink-0">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                      {empName(a.cleaner_id)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-[13px] text-ink-3">No turnovers could be auto-assigned.</div>
            )}
            {unassignable.length > 0 && (
              <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-panel px-3 py-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium text-ink mb-1">
                    {unassignable.length} couldn’t be filled (no available cleaner)
                  </div>
                  {unassignable.map(u => (
                    <div key={u.job_id} className="text-[11px] text-ink-3">{u.title} · {u.date}</div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={state.running}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={onRun}
          disabled={state.loading || state.running || !assigned.length}>
          {state.running ? 'Assigning…' : `Assign ${assigned.length}`}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

export function FixTimesModal({ state, onCancel, onRun }) {
  if (!state) return null
  const jobs = state.preview?.jobs || []
  const bySource = state.bySource || {}
  return (
    <Modal
      open
      onClose={onCancel}
      dismissable={!state.running}
      maxWidth="lg"
      ariaLabel="Fix missing job times"
      title={
        <div className="flex items-center gap-2.5 min-w-0">
          <Clock className="w-5 h-5 text-indigo-600 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">Fix missing job times</div>
            <div className="text-[12px] font-normal text-ink-3 mt-0.5">Jobs showing "– –" get a sensible default (turnovers → property checkout, others → 9:00). Review before applying.</div>
          </div>
        </div>
      }
    >
      <Modal.Body className="space-y-3 scrollbar-thin">
        {state.loading ? (
          <div className="py-12 text-center text-[13px] text-ink-3">Checking job times…</div>
        ) : (
          <>
            {Object.keys(bySource).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(bySource).map(([src, n]) => (
                  <span key={src} className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-bg-2 text-ink-2">
                    {src.replace(/_/g, ' ')}: {n}
                  </span>
                ))}
              </div>
            )}
            {jobs.map(j => (
              <div key={j.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{j.title}</div>
                  <div className="text-[11px] text-ink-3">{j.scheduled_date} · {j.source.replace(/_/g, ' ')}</div>
                </div>
                <span className="text-[11px] font-medium text-ink-2 shrink-0 tabular-nums">
                  {j.new_start}–{(j.new_end || '').slice(0, 5)}
                </span>
              </div>
            ))}
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={state.running}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={onRun}
          disabled={state.loading || state.running || !state.preview?.count}>
          {state.running ? 'Fixing…' : `Fix ${state.preview?.count || 0}`}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}


/** Remove cancelled turnover "ghosts" — the piles of cancelled duplicate
 *  turnovers a flapping iCal feed leaves stacked on one date. Preview-then-
 *  confirm like the other maintenance tools: shows the count with a per-property
 *  breakdown so the office sees exactly what's being cleared. The server only
 *  deletes cancelled str_turnover rows and never one that carries an invoice. */
export function PurgeGhostsModal({ state, onCancel, onRun }) {
  if (!state) return null
  const count = state.preview?.count || 0
  const byProperty = state.preview?.by_property || []
  return (
    <Modal
      open
      onClose={onCancel}
      dismissable={!state.running}
      maxWidth="md"
      ariaLabel="Remove cancelled turnover clutter"
      title={
        <div className="flex items-center gap-2.5 min-w-0">
          <Trash2 className="w-5 h-5 text-indigo-600 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">Remove cancelled turnover clutter</div>
            <div className="text-[12px] font-normal text-ink-3 mt-0.5">Deletes cancelled duplicate turnovers a flapping feed left behind. Live jobs and anything with an invoice are never touched.</div>
          </div>
        </div>
      }
    >
      <Modal.Body className="space-y-3 scrollbar-thin">
        {state.loading ? (
          <div className="py-12 text-center text-[13px] text-ink-3">Counting cancelled turnovers…</div>
        ) : (
          <>
            <p className="text-[13px] text-ink-2">
              {count} cancelled turnover{count === 1 ? '' : 's'} will be permanently removed.
            </p>
            {byProperty.length > 0 && (
              <div className="space-y-1">
                {byProperty.map(p => (
                  <div key={p.property_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                    <div className="text-[13px] text-ink truncate">{p.property}</div>
                    <span className="text-[11px] font-medium text-ink-2 shrink-0 tabular-nums">{p.count}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="flex items-start gap-1.5 text-[11.5px] text-ink-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
              <span>This can't be undone. It only removes cancelled turnovers — your live cleanings stay exactly where they are.</span>
            </p>
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={state.running}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={onRun}
          disabled={state.loading || state.running || !count}>
          {state.running ? 'Removing…' : `Remove ${count}`}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}


/** PRICE BEFORE POST. Opening jobs to the bench used to fire immediately with
 *  no rate, so six Saturday jobs landed on the crew's phones reading "No price
 *  set". This asks for the rate first. It stays OPTIONAL — a sub may name their
 *  own price on an unpriced job (Rule 0: the office offers, it doesn't assign)
 *  — but the ask makes an unpriced post a choice, not a silent default. State
 *  is parent-owned: null | { targets:[…] } | { targets, running }. */
export function OpenToCrewModal({ state, onCancel, onConfirm }) {
  const [rate, setRate] = useState('')
  const rateRef = useRef(null)
  // The owner's "default pay %" (Settings → Rules, BB-CLAIM-04). When set, a
  // blank box no longer means "the sub names their price" — it means "offer it
  // at this share of the job price" — so the hint has to say the true thing.
  // One fetch when the modal opens (it opens rarely; brightbase-economy).
  const [defaultPct, setDefaultPct] = useState(null)
  // Reset the box whenever a fresh batch opens the modal.
  useEffect(() => { setRate('') }, [state?.targets])
  useEffect(() => {
    if (!state) return
    let alive = true
    get('/api/settings/rules')
      .then(r => {
        if (!alive) return
        const rule = (r?.rules || []).find(x => x.key === 'claim_default_pay')
        const f = rule?.fields?.find(x => x.key === 'claim_default_pay_pct')
        setDefaultPct(f?.value ?? null)
      })
      .catch(() => { if (alive) setDefaultPct(null) })
    return () => { alive = false }
  }, [state?.targets])
  if (!state) return null
  const n = state.targets.length
  const busy = !!state.running
  const submit = () => {
    const raw = String(rate).trim()
    onConfirm(raw === '' ? null : Number(raw))
  }
  return (
    <Modal
      open
      onClose={onCancel}
      dismissable={!busy}
      maxWidth="md"
      initialFocusRef={rateRef}
      ariaLabel="Open to the crew"
      title={
        <div className="flex items-center gap-2.5 min-w-0">
          <Sparkles className="w-5 h-5 text-indigo-600 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">Open to the crew</div>
            <div className="text-[12px] font-normal text-ink-3 mt-0.5">
              Set what it pays before it goes on the bench's phones.
            </div>
          </div>
        </div>
      }
    >
      <Modal.Body className="space-y-3">
        <p className="text-[13px] text-ink-2">
          {n} job{n > 1 ? 's' : ''} will go on the board. Subs ask for {n > 1 ? 'them' : 'it'} —
          you pick who gets {n > 1 ? 'each' : 'it'}.
        </p>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">
            What should it pay? <span className="text-ink-3 font-normal">· optional</span>
          </span>
          <input
            ref={rateRef}
            type="number" inputMode="decimal" min="1" step="1"
            value={rate} onChange={e => setRate(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !busy) submit() }}
            placeholder="e.g. 120"
            className="mt-1 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-base text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400" />
        </label>
        <p className="flex items-start gap-1.5 text-[11.5px] text-ink-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3/50" aria-hidden="true" />
          {/* When a default pay % is set (BB-CLAIM-04), a blank box is priced
              automatically — say so instead of the old "the sub names it". */}
          <span>Jobs that already have an asking rate keep theirs.{' '}
            {defaultPct
              ? `Leave this blank and each is offered at your default — ${defaultPct}% of what it bills. Type a rate to override.`
              : 'Leave this blank and a sub names their own price when they ask.'}</span>
        </p>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
          {busy ? 'Posting…' : `Put ${n > 1 ? `${n} ` : ''}on the board`}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
