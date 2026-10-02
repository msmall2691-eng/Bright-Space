/**
 * Direct deposit — the sub's own Stripe payout account (migration 108).
 *
 * WHY THIS EXISTS, and it is not mainly about speed. BrightBase deliberately
 * has no SSN or TIN column, and a sole proprietor's W-9 has an SSN printed on
 * it — so the rule lived in the schema and died in the document store. Stripe
 * collects tax identity on its own page and does not hand it back. Everything
 * on this screen is arranging for the sensitive part to happen somewhere else.
 *
 * NOT A GATE, and the copy says so out loud. Nothing here blocks anyone from
 * asking for work: "you must open a Stripe account to be eligible" is a
 * condition of engagement this arrangement does not need. A sub who never taps
 * this keeps getting paid the way they are paid today, and the screen tells
 * them that rather than nagging.
 *
 * Reads the cached state the webhook writes — no Stripe call to render, no
 * polling (brightbase-economy, scheduling-invariants R1). The one exception is
 * "Check again", which asks Stripe directly on a deliberate tap: the backup for
 * when an `account.updated` event goes missing and the sub would otherwise be
 * stuck on a screen nothing they do can change.
 */
import { useEffect, useState } from 'react'
import { Landmark } from 'lucide-react'
import { get, post } from '../../api'
import { ErrorNote } from './primitives'

export default function CrewPayoutSetup({ previewUserId = null }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(null)

  // Direct-deposit setup is a Stripe onboarding flow the cleaner completes for
  // themselves; there's no preview twin (and starting it would redirect the
  // office to Stripe). In an office preview, show a note instead of fetching.
  const preview = previewUserId != null

  useEffect(() => {
    if (preview) return undefined
    let off = false
    get('/api/crew/me/payouts')
      .then(d => { if (!off) setState(d) })
      .catch(() => { if (!off) setState({ available: false, connected: false }) })
    return () => { off = true }
  }, [preview])

  const start = async () => {
    if (preview) return
    setBusy(true); setError(null)
    try {
      const r = await post('/api/crew/me/payouts/setup', {})
      // Stripe's link is single-use and short-lived, so we hand off
      // immediately rather than storing it.
      if (r?.url) window.location.href = r.url
    } catch (e) {
      setError(e.detail || e.message || 'Could not start the setup')
    } finally { setBusy(false) }
  }

  // THE LOOP THIS BREAKS: they finish at Stripe, come back to a screen that
  // still says Stripe needs more from them, tap "Finish setting it up", get
  // told by Stripe they're already done, and land back on the same amber line.
  // The status only moves when an `account.updated` event arrives, so when one
  // goes missing there is nothing they can do from inside the app. This asks
  // Stripe directly — one call per deliberate tap, never on render.
  const recheck = async () => {
    if (preview) return
    setChecking(true); setError(null)
    try {
      setState(await post('/api/crew/me/payouts/refresh', {}))
    } catch (e) {
      setError(e.detail || e.message || 'Could not check with Stripe')
    } finally { setChecking(false) }
  }

  if (preview) return (
    <p className="text-[12px] text-ink-3">
      Direct-deposit setup is private to this cleaner — not shown in preview.
    </p>
  )

  if (!state) return <p className="text-[12px] text-ink-3">Checking…</p>

  if (!state.available) {
    return (
      <p className="text-[12px] text-ink-3">
        Direct deposit isn’t switched on yet. You’ll be paid the way you are now,
        and the office will let you know when it changes.
      </p>
    )
  }

  return (
    <div className="space-y-2.5">
      {state.payouts_enabled ? (
        <p className="flex items-start gap-1.5 text-[12px] text-ink-2">
          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
          <span>You’re set up. Payouts go straight to your bank.</span>
        </p>
      ) : state.connected ? (
        <>
          <p className="flex items-start gap-1.5 text-[12px] text-ink-2">
            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
            <span>
              Stripe still needs a bit more from you before it can send money.
              {state.needs ? <span className="text-ink-3"> · {state.needs}</span> : null}
            </span>
          </p>
          <button type="button" onClick={start} disabled={busy || checking}
            className="w-full text-[13px] font-medium bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2.5 rounded-lg transition-colors">
            {busy ? 'Opening…' : 'Finish setting it up'}
          </button>
          <button type="button" onClick={recheck} disabled={busy || checking}
            className="w-full text-[12px] text-ink-3 hover:text-ink-2 disabled:opacity-60 py-2 transition-colors underline underline-offset-2">
            {checking ? 'Checking with Stripe…' : 'Already finished? Check again'}
          </button>
        </>
      ) : (
        <>
          <p className="text-[12px] text-ink-3">
            Get paid straight to your bank instead of waiting on a cheque.
            Stripe handles it and asks for your details on their own page —
            we never see your Social Security number.
          </p>
          <button type="button" onClick={start} disabled={busy}
            className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <Landmark className="w-4 h-4" /> {busy ? 'Opening…' : 'Set up direct deposit'}
          </button>
          <p className="text-[11px] text-ink-3">
            Optional. Skip it and nothing changes — you’ll be paid the way you
            are now, and it won’t affect the jobs you can ask for.
          </p>
        </>
      )}
      <ErrorNote>{error}</ErrorNote>
    </div>
  )
}
