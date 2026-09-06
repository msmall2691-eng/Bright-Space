/**
 * Who's asked to join the bench, and the office deciding.
 *
 * The other half of the public /apply form. Applications land here as `new`
 * and go one of three ways: triaged to `reviewing` while somebody makes a
 * call, `declined`, or approved — which is the only step that creates a login.
 *
 * APPROVE IS DELIBERATELY HEAVY. It is the single path from "a stranger filled
 * in a form" to "a stranger can sign in", so it is admin-only, one row at a
 * time, and confirms with what actually happens rather than "are you sure".
 * There is no bulk approve and there shouldn't be.
 *
 * AND IT IS NOT CLEARANCE. Approving gives somebody an account and an invite
 * email; it does not let them take work. Their file — W-9, insurance, the
 * agreement — gates that, and the confirm says so, because the failure worth
 * preventing is an office assuming "approved" meant "vetted".
 *
 * RENDERS NOTHING WHEN NOBODY HAS APPLIED. A permanent empty panel in Settings
 * is a thing people learn to scroll past, and this is where a real applicant
 * would be sitting.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, UserPlus } from 'lucide-react'
import { get, patch, post } from '../api'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import { reportInvite } from '../utils/inviteFallback'

const STATE = {
  new: { dot: 'bg-amber-500', word: 'New' },
  reviewing: { dot: 'bg-blue-500', word: 'Looking at it' },
  approved: { dot: 'bg-emerald-500', word: 'Approved' },
  declined: { dot: 'bg-ink-3/40', word: 'Declined' },
}

const fmtWhen = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : '—')

function isAdmin() {
  try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
  catch { return false }
}

export default function SubApplications() {
  const [data, setData] = useState(null)
  const [filter, setFilter] = useState('new')
  const [openId, setOpenId] = useState(null)
  const [busy, setBusy] = useState(null)
  const admin = isAdmin()

  const load = useCallback(() => {
    // One request: the list plus every status count, so switching filters is
    // local rather than another round trip.
    get('/api/sub-applications').then(setData).catch(() => setData(null))
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (id, fn) => {
    setBusy(id)
    try { await fn(); load() }
    catch (e) { toast.error(e?.detail || e?.message || 'That didn’t go through') }
    finally { setBusy(null) }
  }

  const setStatus = (a, status) =>
    run(a.id, () => patch(`/api/sub-applications/${a.id}`, { status }))

  const approve = async (a) => {
    const ok = await confirmDialog(
      `This creates a crew login for ${a.email} and emails them an invite to set a `
      + 'password.\n\nIt does NOT let them take work yet — they’ll need a W-9, an '
      + 'insurance certificate and the signed agreement on file first, which they '
      + 'do from their own screen.',
      { title: `Approve ${a.name}?`, confirmLabel: 'Approve and invite' },
    )
    if (!ok) return
    await run(a.id, async () => {
      const r = await post(`/api/sub-applications/${a.id}/approve`)
      // A failed invite is not a failed approval — the account is real either
      // way — but it IS the difference between somebody who can sign in and
      // somebody holding an account they can never reach. Say so, with the
      // link, instead of the cheerful message the server used to send back
      // regardless.
      if (await reportInvite(r, a.email)) return
      toast.success(r.message || 'Approved')
    })
  }

  if (!data || !data.applications) return null
  const counts = data.counts || {}
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  if (!total) return null      // nobody has applied; don't draw an empty panel

  const shown = data.applications.filter(a => a.status === filter)

  return (
    <div className="mt-5 rounded-xl border border-hairline bg-panel p-5 sm:p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
        <UserPlus className="h-5 w-5 text-indigo-500" /> Applications
      </h2>
      <p className="mb-4 mt-1 text-[13px] text-ink-3">
        People who filled in the form at <span className="font-medium text-ink-2">/apply</span>.
        Approving one creates their crew login and sends the invite — it doesn’t
        clear them to work.
      </p>

      {/* Quiet underline tabs, counts in the label rather than in a bubble. */}
      <div className="mb-3 flex items-center gap-4 border-b border-hairline">
        {['new', 'reviewing', 'approved', 'declined'].map(s => (
          <button key={s} type="button" onClick={() => setFilter(s)}
            aria-current={filter === s ? 'page' : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-0.5 py-1.5 text-[13px] font-medium transition-colors ${
              filter === s ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}>
            {STATE[s].word} {counts[s] ? `(${counts[s]})` : ''}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing here.</p>
      ) : (
        <div className="space-y-2">
          {shown.map(a => (
            <div key={a.id} className="overflow-hidden rounded-lg border border-hairline">
              <button type="button" onClick={() => setOpenId(openId === a.id ? null : a.id)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-2/60">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-ink">{a.name}</div>
                  <div className="mt-0.5 truncate text-[12px] text-ink-3">
                    {a.email}{a.towns ? ` · ${a.towns}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-[12px] text-ink-3">{fmtWhen(a.created_at)}</span>
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${STATE[a.status].dot}`} aria-hidden="true" />
                    {STATE[a.status].word}
                  </span>
                  <ChevronDown className={`h-4 w-4 text-ink-3 transition-transform ${openId === a.id ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {openId === a.id && (
                <div className="space-y-2 border-t border-hairline px-3 py-3 text-[13px]">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-ink-2 sm:grid-cols-3">
                    {[['Phone', a.phone || '—'], ['Business', a.business_name || '—'],
                      ['EIN', a.ein || '—'], ['Insured', yesNo(a.has_insurance)],
                      ['Transport', yesNo(a.has_transport)], ['Weekends', yesNo(a.weekends)]].map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-[10px] uppercase tracking-wide text-ink-3">{k}</dt>
                        <dd className="text-ink">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {a.experience && (
                    <p className="whitespace-pre-wrap text-ink-2">{a.experience}</p>
                  )}
                  {a.message && (
                    <p className="whitespace-pre-wrap text-ink-3">“{a.message}”</p>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {a.status !== 'approved' && admin && (
                      <button type="button" onClick={() => approve(a)} disabled={busy === a.id}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
                        Approve and invite
                      </button>
                    )}
                    {a.status === 'new' && (
                      <button type="button" onClick={() => setStatus(a, 'reviewing')} disabled={busy === a.id}
                        className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
                        Looking at it
                      </button>
                    )}
                    {a.status !== 'approved' && a.status !== 'declined' && (
                      <button type="button" onClick={() => setStatus(a, 'declined')} disabled={busy === a.id}
                        className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-3 transition-colors hover:bg-bg-2 disabled:opacity-50">
                        Not for us
                      </button>
                    )}
                    {a.status === 'approved' && (
                      <span className="text-[12px] text-ink-3">
                        Account created — they finish their file before taking work.
                      </span>
                    )}
                    {!admin && a.status !== 'approved' && (
                      <span className="text-[12px] text-ink-3">An admin approves.</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
