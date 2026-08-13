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
import { HardHat, RefreshCw, UserPlus, Mail, Link2, CheckCircle2, Clock, Ban } from 'lucide-react'
import { get, post, patch } from '../api'
import { PageHeader, EmptyState, ErrorState, Skeleton } from '../components/ui'
import { pushToast } from '../utils/toastBus'

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
  if ((row.status || '') === 'disabled') return { label: 'Disabled', Icon: Ban, cls: 'bg-red-50 text-red-700 border-red-200' }
  if (row.activated) return { label: 'Active', Icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  return { label: 'Invited', Icon: Clock, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
}

export default function Crew() {
  const [rows, setRows] = useState([])
  const [unclaimed, setUnclaimed] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

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
                  className="inline-flex items-center gap-1.5 text-xs font-medium bg-panel border border-amber-300 text-amber-800 hover:bg-amber-100 rounded-full px-3 py-1.5 transition-colors">
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
              className="text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white px-4 py-2 rounded-lg inline-flex items-center gap-1.5 transition-colors">
              <Mail className="w-4 h-4" /> {adding ? 'Sending…' : 'Add & send invite'}
            </button>
            <span className="text-[11px] text-ink-3">They’ll get an email with a link to set their password (good for 7 days).</span>
          </div>
        </form>

        {/* Roster */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-ink">Crew ({rows.length})</h2>
            <button onClick={load} className="p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2" title="Refresh">
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
                        <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${p.cls}`}>
                          <p.Icon className="w-3 h-3" /> {p.label}
                        </span>
                        {!row.activated && (row.status || '') !== 'disabled' && (
                          <button onClick={() => resend(row.id)} disabled={busyId === row.id}
                            className="text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-60 inline-flex items-center gap-1">
                            <Mail className="w-3.5 h-3.5" /> Resend
                          </button>
                        )}
                      </div>
                    </div>
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
      </div>
    </div>
  )
}
