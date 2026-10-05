/**
 * Apply to join the bench — the public recruiting page.
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
 * WHY IT FOLDS (2026-10). The honest version of this page is long — five
 * sections of arrangement, money and requirements — and the long version is
 * what made a ninety-second decision feel like homework. So the four facts
 * that decide it stay open, and the detail sits behind three folds the person
 * opens if they care. NOTHING IS DELETED BY FOLDING: a fold hides its body
 * with the `hidden` attribute rather than unmounting it, so the W-9, the
 * insurance certificate and the no-SSN line are in the page for a screen
 * reader, for ctrl-F, and for the tests that pin them. Unmounting them would
 * have quietly turned "we told you up front" into "you could have expanded it".
 *
 * THE FORM ASKS FOUR THINGS. Name, email, phone, towns — enough to call
 * somebody back and know whether there's work near them. Business name, EIN,
 * experience, the three yes/no answers and "anything else" are real and still
 * submitted, but they live behind one optional fold, because none of them
 * changes whether the office picks up the phone. EIN especially: the tax
 * details that matter arrive later on a W-9, so asking for one on the first
 * screen only ever made a public form look like paperwork.
 *
 * IT NEVER ASKS FOR A SOCIAL SECURITY NUMBER, and says so where the EIN field
 * is. A sole proprietor's W-9 carries one, and it arrives later inside that
 * document rather than typed into a box on a public web form.
 *
 * UNAUTHENTICATED. No token, no session, no data read back — the only thing
 * this page can do is submit. It cannot tell you whether your email is already
 * known, which is deliberate: an apply form that answers that question is an
 * account-enumeration oracle. That is also why the "already signed up" link
 * below is a plain link to /login and not a lookup: it has to help the person
 * who is already on the bench without answering "is this address one of
 * yours?" for anybody else.
 *
 * EVERYTHING IT CLAIMS IS TRUE OF THE CODE. The steps are the real pipeline
 * (apply → office approves → account → W-9 + certificate of insurance →
 * offers → ask → office says yes → paid per job). The two documents are
 * services/sub_vetting.REQUIRED_KINDS. The counter-offer is
 * JobClaimRequest.requested_rate. No pay figures appear anywhere, because the
 * rate is per job and set by the office — inventing a range here would be the
 * one dishonest thing on the page.
 *
 * IT DESCRIBES A CONTRACTOR ARRANGEMENT AND MUST KEEP DOING SO. "You choose
 * what you take", "nothing is assigned to you", "you can counter" and "no
 * rota" are not marketing lines to soften later — they are the arrangement
 * itself (brightbase-marketplace, Rule 0). A recruiting page that promised
 * steady assigned hours would describe employment.
 *
 * STYLING. Warmer than the office app — more air, a bigger opening line, one
 * primary button — but the same quiet vocabulary: tokens, hairlines, dot+word.
 * No tinted banners, no filled pills, no badges (brightbase-design-language).
 */
import { useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'

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
  'focus:outline-hidden focus:ring-1 focus:ring-blue-400/30'

function Check2({ checked, onChange, children }) {
  return (
    <label className="flex items-start gap-2.5 text-[14px] text-ink-2">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-hairline-2" />
      <span>{children}</span>
    </label>
  )
}

/** A numbered step. Plain type and a quiet rule — no cards, no tints. */
function Step({ n, title, children }) {
  return (
    <li className="flex gap-3 border-b border-hairline/60 py-3 last:border-0">
      <span className="mt-0.5 w-5 shrink-0 text-[13px] font-semibold tabular-nums text-ink-3">
        {n}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-2">{children}</span>
      </span>
    </li>
  )
}

/**
 * A section whose heading is always readable and whose body folds.
 *
 * The body is rendered and hidden, never unmounted — see the file header. That
 * is the whole point of this component: the page still SAYS what it says
 * whether or not anybody clicks, and `hidden` keeps the collapsed content out
 * of the tab order and off the screen without taking it out of the document.
 */
function Fold({ title, summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-hairline/60">
      <h2>
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="flex w-full items-baseline gap-2 py-3.5 text-left">
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-ink">{title}</span>
            {summary && !open && (
              // font-normal: this span lives inside the <h2>, which is bold by
              // default, and a bold summary reads as a second heading.
              <span className="mt-0.5 block text-[13px] font-normal leading-relaxed text-ink-3">{summary}</span>
            )}
          </span>
          <ChevronDown aria-hidden="true"
            className={`mt-1 h-4 w-4 shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </h2>
      <div hidden={!open} className="pb-4">{children}</div>
    </section>
  )
}

/** Dot + line. The same vocabulary the rest of the app uses for a fact. */
function Line({ dot = 'bg-ink-3/50', children }) {
  return (
    <li className="flex items-start gap-2 text-[14px] leading-relaxed text-ink-2">
      <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <span>{children}</span>
    </li>
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
  const [moreOpen, setMoreOpen] = useState(false)

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
          <Check className="h-4 w-4 text-emerald-500" /> Sent
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
    <div className="mx-auto max-w-lg px-5 py-12 sm:py-16">
      {/* The opening. Bigger and warmer than anything in the office app, and
          still plain type on the page background — no hero card, no tint. */}
      <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-ink sm:text-[34px]">
        Clean on your own terms,
        <br />
        in southern Maine.
      </h1>
      <p className="mt-4 text-[16px] leading-relaxed text-ink-2">
        We’re a small cleaning company, and we work with independent cleaners who
        have their own business. You pick up the jobs you want at a set price per
        job, or take on a regular weekly route. You’re not an employee and you’re
        not on a rota.
      </p>

      {/* The four facts that decide it. Everything else folds. */}
      <ul className="mt-6 space-y-2.5">
        <Line dot="bg-emerald-500">
          <span className="text-ink">Paid per job</span>, at a price you see
          before you take it.
        </Line>
        <Line dot="bg-emerald-500">
          <span className="text-ink">You choose what you take</span> — nothing is
          assigned to you, and there’s no penalty for passing.
        </Line>
        <Line dot="bg-emerald-500">
          <span className="text-ink">You can counter.</span> Think a house is
          worth more than the price? Say so.
        </Line>
        <Line dot="bg-amber-500">
          <span className="text-ink">You’ll need your own insurance</span>,
          transport and supplies.
        </Line>
      </ul>

      {/* The door for somebody who is already on the bench. It is a plain
          link, never a lookup: this page must not be able to answer "is this
          email one of yours?". Placed high because the person who needs it
          arrives having been sent the apply link twice. */}
      {/* ink-2, not ink-3: at 13px the tertiary ink measures 3.37:1 on paper,
          under the 4.5:1 minimum, and this is the line that stops an existing
          cleaner filling the form in again. (The app-wide ink-3 ramp is a
          design-system question and is left alone.) */}
      <p className="mt-5 text-[13px] text-ink-2">
        Already cleaning with us?{' '}
        <a href="/login" className="text-ink underline underline-offset-2 hover:text-link">
          Sign in
        </a>{' '}
        — you don’t need to do this again.
      </p>

      {/* ── The form, before the explanations ──────────────────────────────
          A person who already knows they want this shouldn't have to scroll
          past five sections of detail to start typing. Four fields, then the
          button. */}
      <h2 className="mt-10 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        Get set up
      </h2>
      <p className="mt-1.5 text-[13px] text-ink-2">
        Four things, about a minute, and we’ll be in touch.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-4">
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
        <Field label="Which towns can you get to?">
          <input className={inputClass} value={form.towns} placeholder="Scarborough, Saco, Portland…"
            onChange={e => set('towns')(e.target.value)} />
        </Field>

        {/* Everything the office doesn't need in order to call you back.
            Rendered either way so the no-SSN reassurance on the EIN hint is
            always in the page; `hidden` keeps it off screen and out of the
            tab order until it's wanted. */}
        <div className="border-t border-hairline/60 pt-1">
          <button type="button" onClick={() => setMoreOpen(o => !o)} aria-expanded={moreOpen}
            className="flex w-full items-center gap-2 py-2.5 text-left text-[13px] text-ink-2 hover:text-ink">
            <ChevronDown aria-hidden="true"
              className={`h-4 w-4 shrink-0 text-ink-3 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
            Tell us a bit more — optional
          </button>
          <div hidden={!moreOpen} className="space-y-4 pt-2">
            <Field label="Business name" hint="If you have one. Plenty of good cleaners don’t.">
              <input className={inputClass} value={form.business_name}
                onChange={e => set('business_name')(e.target.value)} />
            </Field>
            <Field label="EIN"
              hint="Only if your business has one. Leave it blank if you don’t — never put a social security number here. We ask for tax details later, on a W-9.">
              <input className={inputClass} value={form.ein}
                onChange={e => set('ein')(e.target.value)} />
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
          </div>
        </div>

        {error && (
          <p className="flex items-start gap-1.5 text-[13px] text-ink-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
            {error}
          </p>
        )}

        <button type="submit" disabled={state === 'sending' || missing.length > 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3.5 text-[15px] font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
          {state === 'sending' && <Loader2 className="h-4 w-4 animate-spin" />}
          {state === 'sending' ? 'Sending…' : 'Send my details'}
        </button>
        {missing.length > 0 && (
          <p className="text-center text-[12px] text-ink-3">
            We just need your name and an email to get back to you on.
          </p>
        )}
      </form>

      {/* ── The detail, folded ─────────────────────────────────────────────
          Open by default for "How it works", because what happens after you
          hit send is the question everybody has. The rest answers itself when
          asked. Folded ≠ removed: the bodies are in the document either way. */}
      <div className="mt-12 border-t border-hairline/60">
        <Fold title="How it works"
          summary="Five steps, from this form to getting paid."
          defaultOpen>
          <ol className="rounded-xl border border-hairline bg-panel px-4">
              <Step n="1" title="You send this form">
                Name and an email is enough. It takes a minute and we read every one.
              </Step>
              <Step n="2" title="We get in touch">
                If it looks like a fit we’ll call or email you. If it isn’t, we’ll
                tell you that too.
              </Step>
              <Step n="3" title="You set up your account">
                You’ll get a link to pick a password, then we ask for two things: a
                W-9 and a certificate of insurance. Nothing else is required to start.
              </Step>
              <Step n="4" title="Jobs come to your phone">
                When there’s work in your towns you get a notification with the day,
                the area and the price. You ask for the ones you want. You can ignore
                the rest — there is no penalty for passing, and nothing is assigned
                to you.
              </Step>
              <Step n="5" title="We say yes, you clean, you get paid">
                Once we approve your request the job is yours, with the address and
                the entry details. You’re paid the agreed price per job.
              </Step>
          </ol>
        </Fold>

        <Fold title="How the money works"
          summary="A price per job, never an hourly rate — and you can counter.">
          <ul className="space-y-2">
            <Line>
              <span className="text-ink">A price per job, shown before you say yes.</span>{' '}
              Never an hourly rate, and never a surprise.
            </Line>
            <Line>
              <span className="text-ink">You can counter.</span> If a house is
              bigger than the price suggests, ask for what you think it’s worth
              and we’ll say yes or no. Plenty of people do.
            </Line>
            <Line>
              <span className="text-ink">Regular routes if you want one.</span> A
              standing set of houses on the same day each week, at an agreed price
              — offered, not assigned, and you can hand it back.
            </Line>
            <Line>
              <span className="text-ink">You’re a business, not payroll.</span> No
              tax is withheld, and we send you a 1099 at the end of the year if
              your total passes the IRS reporting threshold.
            </Line>
          </ul>
        </Fold>

        <Fold title="What you’ll need"
          summary="A W-9, proof of insurance, your own transport and supplies.">
          <ul className="space-y-2">
              <Line dot="bg-amber-500">
                <span className="text-ink">A W-9.</span> Standard IRS form so we can
                pay you as a business. We never ask for a Social Security number on
                this page or anywhere in the app.
              </Line>
              <Line dot="bg-amber-500">
                <span className="text-ink">Proof of insurance.</span> Your own
                liability cover — a certificate from your insurer. This is the one
                that stops most people, so it’s worth sorting early.
              </Line>
              <Line>
                <span className="text-ink">Your own transport and supplies.</span>{' '}
                You bring what you clean with.
              </Line>
          </ul>
        </Fold>

        {/* Said plainly, and not softened later. These sentences are the
            arrangement, not the pitch. */}
        <Fold title="What this isn’t"
          summary="No rota, no set hours, nobody assigns you work.">
          <ul className="space-y-2">
            <Line>There’s no rota and no set hours. Quiet weeks are quiet.</Line>
            <Line>Nobody assigns you work. If you don’t ask for a job, it isn’t yours.</Line>
            <Line>You’re free to clean for anyone else, including your own customers.</Line>
          </ul>
        </Fold>
      </div>
    </div>
  )
}
