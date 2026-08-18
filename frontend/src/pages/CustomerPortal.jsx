import { useState, useEffect, useCallback } from 'react'
import {
  Sparkles, Calendar, MapPin, CheckCircle, Clock, FileText, Receipt,
  LogOut, Mail, ArrowRight, ShieldCheck,
} from 'lucide-react'

/**
 * CustomerPortal — the customer's own passwordless home at /portal.
 *
 * No session token yet → a sign-in card (enter email, we send a magic link).
 * Signed in → their visits (with confirm/reschedule via the existing per-visit
 * link), quotes (view/accept), and invoices (read-only for now). Everything is
 * scoped server-side to the email they signed in with — the frontend never
 * asks for or sends a client id.
 */
const TOKEN_KEY = 'bb_portal_token'
const getToken = () => localStorage.getItem(TOKEN_KEY) || ''

// Portal calls are unauthenticated except for the portal bearer token — do NOT
// use the shared api helper (it attaches the STAFF jwt).
async function portalGet(path) {
  const res = await window.fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } })
  if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); throw new Error('unauthorized') }
  if (!res.ok) throw new Error('request failed')
  return res.json()
}
async function portalPost(path, body) {
  const res = await window.fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return res
}

const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US',
  { weekday: 'short', month: 'short', day: 'numeric' }) : ''
const fmtMoney = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmt12 = (t) => {
  if (!t) return ''
  const [h, m] = t.split(':'); const hr = ((parseInt(h, 10) % 12) || 12)
  return `${hr}:${m} ${parseInt(h, 10) < 12 ? 'AM' : 'PM'}`
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    try { await portalPost('/api/portal/request-link', { email: email.trim() }) } catch { /* enumeration-safe: always show sent */ }
    setSent(true); setBusy(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-200 p-7">
        <div className="flex items-center gap-2 mb-1">
          <span className="grid place-items-center w-9 h-9 rounded-xl bg-violet-600 text-white">
            <Sparkles className="w-5 h-5" />
          </span>
          <span className="font-bold text-slate-900 text-lg">The Maine Cleaning Co.</span>
        </div>
        {sent ? (
          <div className="mt-5 text-center">
            <span className="grid place-items-center w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 mx-auto mb-3">
              <Mail className="w-6 h-6" />
            </span>
            <h1 className="text-lg font-bold text-slate-900">Check your email</h1>
            <p className="text-sm text-slate-500 mt-1.5">
              If <span className="font-medium text-slate-700">{email}</span> is on file, we just sent a
              secure sign-in link. It expires in 30 minutes.
            </p>
            <button onClick={() => { setSent(false); setEmail('') }}
              className="mt-4 text-sm font-semibold text-violet-600 hover:text-violet-700">
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-bold text-slate-900 mt-4">Your cleaning portal</h1>
            <p className="text-sm text-slate-500 mt-1">
              Enter your email and we'll send you a secure sign-in link — no password needed.
            </p>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" autoFocus
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500" />
              <button type="submit" disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white font-semibold">
                {busy ? 'Sending…' : <>Email me a sign-in link <ArrowRight className="w-4 h-4" /></>}
              </button>
            </form>
            <p className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-4">
              <ShieldCheck className="w-3.5 h-3.5" /> We only show cleanings tied to your email address.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Section({ icon: Icon, title, children, count }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-slate-100">
        <span className="grid place-items-center w-8 h-8 rounded-lg bg-violet-50 text-violet-600 shrink-0">
          <Icon className="w-4 h-4" />
        </span>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {count > 0 && <span className="text-[11px] font-bold text-slate-500">{count}</span>}
      </div>
      {children}
    </section>
  )
}

const STATUS_TONE = {
  scheduled: 'bg-blue-50 text-blue-700', confirmed: 'bg-emerald-50 text-emerald-700',
  completed: 'bg-slate-100 text-slate-600', sent: 'bg-blue-50 text-blue-700',
  accepted: 'bg-emerald-50 text-emerald-700', paid: 'bg-emerald-50 text-emerald-700',
  overdue: 'bg-red-50 text-red-700', draft: 'bg-slate-100 text-slate-600',
}
const Pill = ({ children, tone }) => (
  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${tone || 'bg-slate-100 text-slate-600'}`}>
    {children}
  </span>
)

function Dashboard({ onSignOut }) {
  const [me, setMe] = useState(null)
  const [visits, setVisits] = useState({ upcoming: [], past: [] })
  const [quotes, setQuotes] = useState([])
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [expired, setExpired] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [m, v, q, i] = await Promise.all([
        portalGet('/api/portal/me'),
        portalGet('/api/portal/visits'),
        portalGet('/api/portal/quotes'),
        portalGet('/api/portal/invoices'),
      ])
      setMe(m); setVisits(v); setQuotes(q.quotes || []); setInvoices(i.invoices || [])
    } catch (e) {
      if (String(e.message) === 'unauthorized') setExpired(true)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  if (expired) { onSignOut(); return null }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 safe-top z-10">
        <div className="max-w-3xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="grid place-items-center w-8 h-8 rounded-lg bg-violet-600 text-white shrink-0">
              <Sparkles className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-900 truncate">
                {me?.name ? `Hi, ${me.name.split(' ')[0]}` : 'Your portal'}
              </div>
              <div className="text-[11px] text-slate-400 truncate">The Maine Cleaning Co.</div>
            </div>
          </div>
          <button onClick={onSignOut}
            className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-500 hover:text-slate-800">
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-5 space-y-4">
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map(i => <div key={i} className="h-24 rounded-2xl bg-white border border-slate-200 animate-pulse" />)}
          </div>
        ) : (
          <>
            <Section icon={Calendar} title="Upcoming visits" count={visits.upcoming.length}>
              {visits.upcoming.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-slate-400">No upcoming visits scheduled.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {visits.upcoming.map(v => (
                    <div key={v.id} className="px-5 py-3.5 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-slate-900">{fmtDate(v.date)}</span>
                          {v.start_time && <span className="text-[12px] text-slate-500">{fmt12(v.start_time)}</span>}
                          {v.confirmed
                            ? <Pill tone="bg-emerald-50 text-emerald-700">confirmed</Pill>
                            : v.reschedule_pending
                              ? <Pill tone="bg-amber-50 text-amber-700">change requested</Pill>
                              : <Pill tone={STATUS_TONE[v.status]}>{v.status}</Pill>}
                        </div>
                        {v.address && (
                          <div className="flex items-center gap-1 text-[12px] text-slate-500 mt-0.5">
                            <MapPin className="w-3.5 h-3.5 shrink-0" /> {v.address}
                          </div>
                        )}
                      </div>
                      {v.manage_token && (
                        <a href={`/job/${v.manage_token}`}
                          className="shrink-0 text-[12px] font-semibold text-violet-600 hover:text-violet-700 inline-flex items-center gap-1">
                          {v.confirmed ? 'Reschedule' : 'Confirm / reschedule'} <ArrowRight className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {quotes.length > 0 && (
              <Section icon={FileText} title="Your quotes" count={quotes.length}>
                <div className="divide-y divide-slate-100">
                  {quotes.map(q => (
                    <a key={q.id} href={q.view_token ? `/quote/${q.view_token}` : undefined}
                      className={`px-5 py-3.5 flex items-center gap-3 ${q.view_token ? 'hover:bg-slate-50' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">{q.title || q.number}</div>
                        <div className="text-[12px] text-slate-500">{q.number}</div>
                      </div>
                      <span className="text-sm font-semibold text-slate-900">{fmtMoney(q.total)}</span>
                      <Pill tone={STATUS_TONE[q.status]}>{(q.status || '').replace(/_/g, ' ')}</Pill>
                    </a>
                  ))}
                </div>
              </Section>
            )}

            {invoices.length > 0 && (
              <Section icon={Receipt} title="Your invoices" count={invoices.length}>
                <div className="divide-y divide-slate-100">
                  {invoices.map(inv => (
                    <div key={inv.id} className="px-5 py-3.5 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">{inv.number}</div>
                        {inv.due_date && <div className="text-[12px] text-slate-500">Due {fmtDate(inv.due_date)}</div>}
                      </div>
                      <span className="text-sm font-semibold text-slate-900">{fmtMoney(inv.total)}</span>
                      <Pill tone={inv.paid ? STATUS_TONE.paid : STATUS_TONE[inv.status]}>
                        {inv.paid ? 'paid' : (inv.status || '').replace(/_/g, ' ')}
                      </Pill>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {visits.past.length > 0 && (
              <Section icon={Clock} title="Recent visits" count={visits.past.length}>
                <div className="divide-y divide-slate-100">
                  {visits.past.slice(0, 8).map(v => (
                    <div key={v.id} className="px-5 py-3 flex items-center gap-3">
                      <CheckCircle className="w-4 h-4 text-slate-300 shrink-0" />
                      <span className="text-[13px] text-slate-600">{fmtDate(v.date)}</span>
                      {v.address && <span className="text-[12px] text-slate-400 truncate">{v.address}</span>}
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default function CustomerPortal() {
  const [signedIn, setSignedIn] = useState(() => !!getToken())
  const signOut = () => { localStorage.removeItem(TOKEN_KEY); setSignedIn(false) }
  // Re-check after a verify redirect stores the token.
  useEffect(() => {
    const onStorage = () => setSignedIn(!!getToken())
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return signedIn ? <Dashboard onSignOut={signOut} /> : <SignIn />
}
