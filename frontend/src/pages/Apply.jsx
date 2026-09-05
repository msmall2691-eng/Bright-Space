/**
 * Apply to join the bench — the public form.
 *
 * The last piece of the marketplace pivot, and last on purpose: an apply form
 * is worthless until there's a file for an accepted sub to fill in, a way to
 * pay them, and work to offer them. All three now exist.
 *
 * WHO THIS IS FOR. A cleaner with their own business, on a phone, deciding in
 * about ninety seconds whether this is worth their time. So the page leads with
 * what they get and what's expected, and the form is short: the office only
 * needs enough to decide who's worth a phone call. Everything else — insurance
 * certificate, W-9, the agreement — comes after they're accepted, on a screen
 * built for it.
 *
 * IT NEVER ASKS FOR A SOCIAL SECURITY NUMBER, and says so where the EIN field
 * is. A sole proprietor's W-9 carries one, and it arrives later inside that
 * document rather than typed into a box on a public web form.
 *
 * UNAUTHENTICATED. No token, no session, no data read back — the only thing
 * this page can do is submit. It cannot tell you whether your email is already
 * known, which is deliberate: an apply form that answers that question is an
 * account-enumeration oracle.
 */
import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'

const API = '/api/apply'

const FIELDS_REQUIRED = ['name', 'email']

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  )
}

const inputClass =
  'w-full rounded-lg border border-hairline bg-panel px-3 py-2.5 text-[15px] text-ink ' +
  'focus:outline-none focus:ring-1 focus:ring-blue-400/30'

function Check2({ checked, onChange, children }) {
  return (
    <label className="flex items-start gap-2.5 text-[14px] text-ink-2">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-2" />
      <span>{children}</span>
    </label>
  )
}

export default function Apply() {
  const [form, setForm] = useState({
    name: '', email: '', phone: '', business_name: '', ein: '',
    towns: '', experience: '', message: '',
    has_insurance: false, has_transport: false, weekends: false,
    website: '',                 // honeypot — hidden, never filled by a person
  })
  const [state, setState] = useState('idle')   // idle | sending | sent | error
  const [error, setError] = useState('')

  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }))
  const missing = FIELDS_REQUIRED.filter(f => !form[f].trim())

  const submit = async (e) => {
    e.preventDefault()
    if (missing.length) return
    setState('sending'); setError('')
    try {
      // Plain fetch, not the app's api client: that one attaches a JWT and
      // redirects to /login on 401. There is no session here and there
      // shouldn't be.
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, source: 'web' }),
      })
      if (res.status === 429) {
        setState('error')
        setError('That’s a lot of tries in a short time. Give it an hour and try again.')
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setState('error')
        setError(body.detail || 'Something went wrong sending that. Try again in a minute.')
        return
      }
      setState('sent')
    } catch {
      setState('error')
      setError('Couldn’t reach us just now — check your connection and try again.')
    }
  }

  if (state === 'sent') {
    return (
      <div className="mx-auto max-w-lg px-5 py-16">
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <Check className="h-4 w-4 text-emerald-500" /> Application sent
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          Thanks — we’ve got it.
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Someone will look at it and get back to you. If it’s a fit, you’ll get an
          email with a link to set up your account, and then we’ll ask for your
          insurance certificate and a W-9 before you start taking work.
        </p>
        <p className="mt-3 text-[13px] text-ink-3">
          Nothing else to do for now. You can close this page.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Cleaning work in southern Maine
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        We’re a small cleaning company and we hire independent cleaners with their
        own business. You pick up the jobs you want at a set price per job, or take
        on a regular weekly route. You’re not an employee and you’re not on a rota.
      </p>
      <ul className="mt-4 space-y-1.5 text-[14px] text-ink-2">
        {[
          'Paid per job, at a price you see before you take it.',
          'You choose what you take — nothing is assigned to you.',
          'You’ll need your own insurance, transport and supplies.',
        ].map(line => (
          <li key={line} className="flex items-start gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3/50" aria-hidden="true" />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <form onSubmit={submit} className="mt-8 space-y-4">
        {/* Honeypot. Off-screen rather than display:none — some bots skip
            hidden inputs but fill positioned ones. No label a screen reader
            would read as a real question, and never tab-reachable. */}
        <div aria-hidden="true"
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
          <input type="text" tabIndex={-1} autoComplete="off" value={form.website}
            onChange={e => set('website')(e.target.value)} />
        </div>

        <Field label="Your name">
          <input className={inputClass} value={form.name} autoComplete="name"
            onChange={e => set('name')(e.target.value)} />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" value={form.email} autoComplete="email"
            onChange={e => set('email')(e.target.value)} />
        </Field>
        <Field label="Phone" hint="Optional, but it’s usually the quickest way to reach you.">
          <input className={inputClass} type="tel" value={form.phone} autoComplete="tel"
            onChange={e => set('phone')(e.target.value)} />
        </Field>
        <Field label="Business name" hint="If you have one. Plenty of good cleaners don’t.">
          <input className={inputClass} value={form.business_name}
            onChange={e => set('business_name')(e.target.value)} />
        </Field>
        <Field label="EIN"
          hint="Only if your business has one. Leave it blank if you don’t — never put a social security number here. We ask for tax details later, on a W-9.">
          <input className={inputClass} value={form.ein}
            onChange={e => set('ein')(e.target.value)} />
        </Field>
        <Field label="Which towns can you get to?">
          <input className={inputClass} value={form.towns} placeholder="Scarborough, Saco, Portland…"
            onChange={e => set('towns')(e.target.value)} />
        </Field>
        <Field label="Cleaning experience">
          <textarea className={`${inputClass} min-h-[90px]`} value={form.experience}
            onChange={e => set('experience')(e.target.value)} />
        </Field>

        <div className="space-y-2.5 pt-1">
          <Check2 checked={form.has_insurance} onChange={set('has_insurance')}>
            I have liability insurance, or I can get it
          </Check2>
          <Check2 checked={form.has_transport} onChange={set('has_transport')}>
            I have my own transport
          </Check2>
          <Check2 checked={form.weekends} onChange={set('weekends')}>
            I can work weekends — Saturdays are our busiest day
          </Check2>
        </div>

        <Field label="Anything else?">
          <textarea className={`${inputClass} min-h-[70px]`} value={form.message}
            onChange={e => set('message')(e.target.value)} />
        </Field>

        {error && (
          <p className="flex items-start gap-1.5 text-[13px] text-ink-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
            {error}
          </p>
        )}

        <button type="submit" disabled={state === 'sending' || missing.length > 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-[15px] font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
          {state === 'sending' && <Loader2 className="h-4 w-4 animate-spin" />}
          {state === 'sending' ? 'Sending…' : 'Send application'}
        </button>
        {missing.length > 0 && (
          <p className="text-center text-[12px] text-ink-3">
            We just need your name and an email to get back to you on.
          </p>
        )}
      </form>
    </div>
  )
}
