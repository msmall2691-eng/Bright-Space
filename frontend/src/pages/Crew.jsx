/**
 * Crew — native crew setup.
 *
 * The office runs the crew from here: add a cleaner (which emails them a link to
 * set their own password), set per-cleaner pay rates, and claim the crew IDs
 * already sitting on scheduled jobs so nobody falls off the schedule (crew IDs
 * on older jobs were originally imported from the retired external scheduling
 * app). All reads/writes are our own database.
 *
 * Backend: GET /api/crew/roster, GET /api/crew/unclaimed-ids, POST /api/crew,
 * POST /api/crew/{id}/resend-invite, and pay-rate/crew-ID edits reuse the
 * existing admin PATCH /api/auth/users/{id}.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { HardHat, RefreshCw, UserPlus, Mail, Link2 } from 'lucide-react'
import { get, post, patch } from '../api'
import { PageHeader, EmptyState, ErrorState, Skeleton } from '../components/ui'
import { pushToast } from '../utils/toastBus'
import CrewDocsAdmin from '../components/crew/CrewDocsAdmin'
import { MessageSquare, Send, X } from 'lucide-react'

/** Office side of the cleaner↔office thread (crew app "message the office").
 *  One drawer per cleaner; replies push to their phone. */
function OfficeCrewThread({ user, onClose }) {
  const [msgs, setMsgs] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    get(`/api/crew/messages/${user.id}`).then(setMsgs).catch(() => setMsgs([]))
  }, [user.id])
  useEffect(() => { load() }, [load])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    try {
      await post(`/api/crew/messages/${user.id}`, { body: text })
      setDraft(''); load()
    } catch (e) {
      pushToast({ type: 'error', message: e.detail || e.message || 'Could not send' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-panel border-l border-hairline flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold text-ink">{user.full_name || user.email}</div>
            <div className="text-[11px] text-ink-3">Replies ping their phone</div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="grid place-items-center w-8 h-8 rounded-md bg-bg-2 text-ink-3">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
          {!msgs && <div className="h-24 rounded-xl bg-bg-2 animate-pulse" />}
          {msgs?.length === 0 && (
            <p className="text-[12.5px] text-ink-3 text-center pt-8">No messages yet.</p>
          )}
          {(msgs || []).map(m => (
            <div key={m.id} className={`max-w-[85%] ${m.sender === 'office' ? 'ml-auto' : ''}`}>
              <div className={`rounded-2xl px-3.5 py-2 text-[13.5px] whitespace-pre-wrap ${
                m.sender === 'office'
                  ? 'bg-indigo-600 text-white rounded-br-md'
                  : 'bg-bg-2 border border-hairline text-ink rounded-bl-md'}`}>
                {m.body}
              </div>
              <div className={`text-[10px] text-ink-3 mt-0.5 ${m.sender === 'office' ? 'text-right' : ''}`}>
                {m.created_at ? new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-hairline px-3 py-2.5 flex items-end gap-2">
          <textarea value={draft} rows={1} maxLength={2000}
            onChange={e => setDraft(e.target.value)}
            placeholder={`Message ${(user.full_name || '').split(' ')[0] || 'them'}…`}
            className="flex-1 resize-none rounded-xl border border-hairline bg-bg px-3 py-2.5 text-[14px] text-ink focus:outline-none focus:border-indigo-400" />
          <button onClick={send} disabled={busy || !draft.trim()} aria-label="Send"
            className="grid place-items-center w-10 h-10 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 transition-colors">
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

const numOrNull = (v) => {
  const s = String(v ?? '').trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isNaN(n) ? null : n
}
const isEmail = (s) => /.+@.+\..+/.test(String(s || '').trim())

// Activation/access state for the pill — mirrors the backend's status/active
// truth: a cleaner is "Active" once they've set a password (accepted the
// invite), "Invited" until then, and "Disabled" if the account was shut off.
function pill(row) {
  if ((row.status || '') === 'disabled') return { label: 'Disabled', dot: 'bg-red-500' }
  if (row.activated) return { label: 'Active', dot: 'bg-emerald-500' }
  return { label: 'Invited', dot: 'bg-amber-500' }
}

export default function Crew() {
  const [rows, setRows] = useState([])
  const [unclaimed, setUnclaimed] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [threadUser, setThreadUser] = useState(null)   // office↔cleaner chat drawer

  // Add-cleaner form
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [crewId, setCrewId] = useState('')
  const [res, setRes] = useState('')
  const [rental, setRental] = useState('')
  const [deep, setDeep] = useState('')
  const [adding, setAdding] = useState(false)
  const nameRef = useRef(null)

  const load = useCallback(() => {
    setLoading(true); setError(null)
    Promise.all([get('/api/crew/roster'), get('/api/crew/unclaimed-ids')])
      .then(([r, u]) => { setRows(Array.isArray(r) ? r : []); setUnclaimed(Array.isArray(u) ? u : []) })
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const reloadUnclaimed = () => get('/api/crew/unclaimed-ids').then(u => setUnclaimed(Array.isArray(u) ? u : [])).catch(() => {})

  const addCleaner = async (e) => {
    e?.preventDefault?.()
    if (!isEmail(email)) { pushToast('Enter a valid email to invite a cleaner.', 'error'); return }
    setAdding(true)
    try {
      const row = await post('/api/crew', {
        full_name: fullName.trim(),
        email: email.trim(),
        cleaner_id: crewId.trim() || null,
        pay_rate_residential: numOrNull(res),
        pay_rate_rental: numOrNull(rental),
        pay_rate_deep: numOrNull(deep),
      })
      setRows(rs => [row, ...rs])
      setFullName(''); setEmail(''); setCrewId(''); setRes(''); setRental(''); setDeep('')
      reloadUnclaimed()  // if this named a scheduled crew ID, it's no longer unclaimed
      pushToast(`Invite sent to ${row.email}`, 'success')
    } catch (err) {
      pushToast(err?.message || 'Could not add that cleaner.', 'error')
    } finally {
      setAdding(false)
    }
  }

  // Pay-rate / crew-ID edits reuse the admin user PATCH; optimistically merge the
  // fields we sent (the backend echoes them) so the row updates without a refetch.
  const savePatch = async (id, patchObj) => {
    try {
      await patch(`/api/auth/users/${id}`, patchObj)
      setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patchObj } : r)))
      if ('cleaner_id' in patchObj) reloadUnclaimed()
    } catch (err) {
      pushToast(err?.message || 'Could not save that change.', 'error')
      load()  // resync from the server so the input doesn't show a value that didn't stick
    }
  }

  const resend = async (id) => {
    setBusyId(id)
    try { await post(`/api/crew/${id}/resend-invite`); pushToast('Invite re-sent.', 'success') }
    catch (err) { pushToast(err?.message || 'Could not resend the invite.', 'error') }
    finally { setBusyId(null) }
  }

  const claim = (cid) => {
    setCrewId(cid)
    nameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    nameRef.current?.focus()
  }

  const rateInput = (row, field, value, placeholder) => (
    <label className="block">
      <span className="text-[11px] text-ink-3">{placeholder}</span>
      <input
        key={`${row.id}-${field}-${value ?? ''}`}
        type="number" step="0.5" min="0"
        defaultValue={value ?? ''}
        placeholder="$/hr"
        disabled={busyId === row.id}
        onBlur={(e) => {
          const v = numOrNull(e.target.value)
          if (v !== (value ?? null)) savePatch(row.id, { [field]: v })
        }}
        className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
    </label>
  )

  return (
    <div className="pb-10">
      <PageHeader
        icon={HardHat}
        iconColor="violet"
        title="Crew"
        subtitle="Add cleaners, set their pay rates, and send each one a link to set their own password."
      />

      <div className="px-4 sm:px-8 space-y-5 max-w-4xl">
        {/* Unclaimed crew IDs — the cutover safety net. Only shows when there are
            crew IDs on upcoming jobs that no login owns yet. */}
        {!loading && unclaimed.length > 0 && (
          <div className="border border-amber-200 bg-amber-50/60 rounded-xl p-4">
            <div className="flex items-center gap-2 text-amber-800 font-semibold text-sm mb-1">
              <Link2 className="w-4 h-4" /> Crew IDs on the schedule with no login yet
            </div>
            <p className="text-[13px] text-amber-700/90 mb-3">
              These crew IDs are assigned to upcoming jobs but aren’t linked to anyone. Add a cleaner
              with the matching ID so their jobs show up for them — and so no one falls off the
              schedule.
            </p>
            <div className="flex flex-wrap gap-2">
              {unclaimed.map(u => (
                <button key={u.cleaner_id} onClick={() => claim(u.cleaner_id)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium bg-panel border border-amber-300 text-amber-800 hover:bg-amber-100 rounded-md px-3 py-1.5 transition-colors">
                  <UserPlus className="w-3.5 h-3.5" />
                  <span className="font-semibold">{u.cleaner_id}</span>
                  <span className="text-amber-600">· {u.upcoming_jobs} job{u.upcoming_jobs === 1 ? '' : 's'}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add cleaner */}
        <form onSubmit={addCleaner} className="border border-hairline bg-panel rounded-xl p-4">
          <div className="flex items-center gap-2 text-ink font-semibold text-sm mb-3">
            <UserPlus className="w-4 h-4 text-indigo-500" /> Add a cleaner
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-3">Name</span>
              <input ref={nameRef} value={fullName} onChange={e => setFullName(e.target.value)}
                placeholder="Full name" disabled={adding}
                className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-3">Email <span className="text-red-500">*</span></span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="cleaner@email.com" disabled={adding}
                className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-[11px] text-ink-3">Crew ID <span className="text-ink-3">(optional — links them to jobs already assigned)</span></span>
              <input value={crewId} onChange={e => setCrewId(e.target.value)}
                placeholder="e.g. 123" disabled={adding}
                className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-3">Residential $/hr</span>
              <input type="number" step="0.5" min="0" value={res} onChange={e => setRes(e.target.value)}
                placeholder="Blank = shop default" disabled={adding}
                className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-3">Rental (turnover) $/hr</span>
              <input type="number" step="0.5" min="0" value={rental} onChange={e => setRental(e.target.value)}
                placeholder="Blank = shop default" disabled={adding}
                className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-3">Deep-clean $/hr</span>
              <input type="number" step="0.5" min="0" value={deep} onChange={e => setDeep(e.target.value)}
                placeholder="Blank = shop default" disabled={adding}
                className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button type="submit" disabled={adding}
              className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white px-4 py-2 rounded-md inline-flex items-center gap-1.5 transition-colors">
              <Mail className="w-4 h-4" /> {adding ? 'Sending…' : 'Add & send invite'}
            </button>
            <span className="text-[11px] text-ink-3">They’ll get an email with a link to set their password (good for 7 days).</span>
          </div>
        </form>

        {/* Roster */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-ink">Crew ({rows.length})</h2>
            <button onClick={load} className="p-1.5 rounded-md text-ink-3 hover:text-ink-2 hover:bg-bg-2" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {loading && <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>}
          {!loading && error && <ErrorState onRetry={load} compact />}
          {!loading && !error && rows.length === 0 && (
            <EmptyState icon={HardHat} title="No cleaners yet"
              description="Add your first cleaner above — they’ll get an invite to set their password and see their schedule." compact />
          )}

          {!loading && !error && rows.length > 0 && (
            <div className="space-y-3">
              {rows.map(row => {
                const p = pill(row)
                return (
                  <div key={row.id} className="border border-hairline bg-panel rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink truncate">{row.full_name || row.email}</div>
                        <div className="text-xs text-ink-3 truncate">{row.email}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
                          <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} /> {p.label}
                        </span>
                        {!row.activated && (row.status || '') !== 'disabled' && (
                          <button onClick={() => resend(row.id)} disabled={busyId === row.id}
                            className="text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-60 inline-flex items-center gap-1">
                            <Mail className="w-3.5 h-3.5" /> Resend
                          </button>
                        )}
                      </div>
                    </div>
                    <button onClick={() => setThreadUser(row)}
                      className="mb-2 inline-flex h-7 items-center gap-1.5 text-xs font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2.5 hover:bg-bg-2 transition-colors">
                      <MessageSquare className="w-3.5 h-3.5" /> Message
                    </button>
                    <label className="flex items-center gap-2 mb-2 text-[12px] font-medium text-ink-2 cursor-pointer ml-3">
                      <input type="checkbox"
                        checked={!!row.can_view_full_schedule}
                        disabled={busyId === row.id}
                        onChange={(e) => savePatch(row.id, { can_view_full_schedule: e.target.checked })} />
                      Lead — sees the whole crew's schedule (names &amp; times only, never door codes)
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <label className="block">
                        <span className="text-[11px] text-ink-3">Crew ID</span>
                        <input
                          key={`${row.id}-cid-${row.cleaner_id || ''}`}
                          defaultValue={row.cleaner_id || ''}
                          placeholder="—"
                          disabled={busyId === row.id}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v !== (row.cleaner_id || '')) savePatch(row.id, { cleaner_id: v })
                          }}
                          className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </label>
                      {rateInput(row, 'pay_rate_residential', row.pay_rate_residential, 'Residential $/hr')}
                      {rateInput(row, 'pay_rate_rental', row.pay_rate_rental, 'Rental $/hr')}
                      {rateInput(row, 'pay_rate_deep', row.pay_rate_deep, 'Deep $/hr')}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <CrewDocsAdmin />
      </div>
      {threadUser && <OfficeCrewThread user={threadUser} onClose={() => setThreadUser(null)} />}
    </div>
  )
}
