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
import { HardHat, RefreshCw, UserPlus, Mail } from 'lucide-react'
import { get, post, patch } from '../api'
import { PageHeader, EmptyState, ErrorState, Skeleton, SubNav } from '../components/ui'
import { pushToast } from '../utils/toastBus'
import CrewDocsAdmin from '../components/crew/CrewDocsAdmin'
import { CrewThreadPane } from '../components/comms/CrewThreadPane'
import { MessageSquare, Sparkles, X } from 'lucide-react'
import { Link } from 'react-router-dom'

/** Office side of the cleaner↔office thread (crew app "message the office").
 *  One drawer per cleaner; replies push to their phone. The thread body is
 *  the SAME component the Messages page's Crew view renders inline
 *  (components/comms/CrewThreadPane) — one implementation, two entrances.
 *  `initialDraft` prefills the composer (the AI day-plan draft) —
 *  review-first: nothing sends until the office edits/approves and hits
 *  Send, and the cleaner just sees a normal office message. */
function OfficeCrewThread({ user, initialDraft, onClose }) {
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
        <CrewThreadPane
          userId={user.id}
          firstName={(user.full_name || '').split(' ')[0]}
          initialDraft={initialDraft}
        />
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

// "Add & send invite" (POST /api/crew), "Resend" (POST /crew/{id}/resend-invite),
// and every inline field edit here (PATCH /api/auth/users/{id} — name, email,
// crew ID, pay rates, home address, lead checkbox) are admin-only on the
// backend (backend/modules/crew/router.py, backend/modules/auth/router.py).
// The roster itself is admin+manager (GET /api/crew/roster), so managers can
// reach this page — gate just the writes so a manager's save doesn't
// silently 403.
function useIsAdmin() {
  try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
  catch { return false }
}

export default function Crew() {
  const isAdmin = useIsAdmin()
  const [rows, setRows] = useState([])
  const [unclaimed, setUnclaimed] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  // Office↔cleaner chat drawer: { user, draft } — draft prefills the composer
  // when opened via "Draft day plan", '' when opened via plain "Message".
  const [thread, setThread] = useState(null)
  const [draftingId, setDraftingId] = useState(null)   // per-row day-plan spinner

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

  // Mia drafts tomorrow's day message for one cleaner (backend defaults the
  // date to the next business day); the returned text lands in the normal
  // thread composer for review — the endpoint sends nothing itself. The
  // backend returns the error envelope ({error}) with HTTP 200, matching the
  // other AI draft endpoints, so check both shapes.
  const draftDayPlan = async (row) => {
    setDraftingId(row.id)
    try {
      const res = await post(`/api/ai/draft-crew-message/${row.id}`, {})
      if (res?.error) { pushToast(res.error, 'error'); return }
      setThread({ user: row, draft: res?.message || '' })
    } catch (err) {
      pushToast(err?.message || 'Could not draft a day plan.', 'error')
    } finally {
      setDraftingId(null)
    }
  }

  const claim = (cid) => {
    setCrewId(cid)
    nameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    nameRef.current?.focus()
  }

  const rateInput = (row, field, value, placeholder) => (
    <label className="block" title={isAdmin ? undefined : 'Admin only'}>
      <span className="text-[11px] text-ink-3">{placeholder}</span>
      <input
        key={`${row.id}-${field}-${value ?? ''}`}
        type="number" step="0.5" min="0"
        defaultValue={value ?? ''}
        placeholder="$/hr"
        disabled={busyId === row.id || !isAdmin}
        onBlur={(e) => {
          const v = numOrNull(e.target.value)
          if (v !== (value ?? null)) savePatch(row.id, { [field]: v })
        }}
        className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
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
        actions={
          <Link to="/comms?view=crew"
            className="inline-flex h-8 items-center gap-1.5 text-xs font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2.5 hover:bg-bg-2 no-underline transition-colors">
            <MessageSquare className="w-3.5 h-3.5" /> Crew chat
          </Link>
        }
      >
        <SubNav />
      </PageHeader>

      <div className="px-4 sm:px-8 space-y-5 max-w-4xl">
        {/* Unclaimed crew IDs — the cutover safety net. Only shows when there are
            crew IDs on upcoming jobs that no login owns yet. Attention =
            hairline card + amber dot (design law), not a tinted banner. */}
        {!loading && unclaimed.length > 0 && (
          <div className="bg-panel border border-hairline rounded-lg p-4">
            <div className="flex items-center gap-2 font-semibold text-sm text-ink mb-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
              Crew IDs on the schedule with no login yet
            </div>
            <p className="text-[13px] text-ink-2 mb-3">
              These crew IDs are assigned to upcoming jobs but aren’t linked to anyone. Add a cleaner
              with the matching ID so their jobs show up for them — and so no one falls off the
              schedule.
            </p>
            <div className="flex flex-wrap gap-2">
              {unclaimed.map(u => (
                <button key={u.cleaner_id} onClick={() => claim(u.cleaner_id)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 rounded-md px-3 py-1.5 transition-colors">
                  <UserPlus className="w-3.5 h-3.5" />
                  <span className="font-semibold">{u.cleaner_id}</span>
                  <span className="text-ink-3">· {u.upcoming_jobs} job{u.upcoming_jobs === 1 ? '' : 's'}</span>
                </button>
              ))}
            </div>
          </div>
        )}


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
              description="Add your first cleaner below — they’ll get an invite to set their password and see their schedule." compact />
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
                          <button onClick={() => resend(row.id)} disabled={busyId === row.id || !isAdmin}
                            title={isAdmin ? undefined : 'Admin only'}
                            className="text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1">
                            <Mail className="w-3.5 h-3.5" /> Resend
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mb-2 flex items-center gap-2">
                      <button onClick={() => setThread({ user: row, draft: '' })}
                        className="inline-flex h-7 items-center gap-1.5 text-xs font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2.5 hover:bg-bg-2 transition-colors">
                        <MessageSquare className="w-3.5 h-3.5" /> Message
                      </button>
                      <button onClick={() => draftDayPlan(row)}
                        disabled={draftingId === row.id}
                        title="Draft tomorrow's day message for review — nothing sends until you hit Send"
                        className="inline-flex h-7 items-center gap-1.5 text-xs font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2.5 hover:bg-bg-2 disabled:opacity-60 transition-colors">
                        <Sparkles className={`w-3.5 h-3.5 ${draftingId === row.id ? 'animate-pulse' : ''}`} />
                        {draftingId === row.id ? 'Drafting…' : 'Draft day plan'}
                      </button>
                    </div>
                    <label className="flex items-center gap-2 mb-2 text-[12px] font-medium text-ink-2 cursor-pointer ml-3"
                      title={isAdmin ? undefined : 'Admin only'}>
                      <input type="checkbox"
                        checked={!!row.can_view_full_schedule}
                        disabled={busyId === row.id || !isAdmin}
                        onChange={(e) => savePatch(row.id, { can_view_full_schedule: e.target.checked })} />
                      Lead — sees the whole crew's schedule (names &amp; times only, never door codes)
                    </label>
                    {/* Name + email — same inline save-on-blur path as crew ID and
                        pay rates (admin PATCH /api/auth/users/{id}); the backend
                        422s on blank/invalid and 409s on a duplicate email, and
                        savePatch toasts that message and resyncs. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-2.5">
                      <label className="block" title={isAdmin ? undefined : 'Admin only'}>
                        <span className="text-[11px] text-ink-3">Name</span>
                        <input
                          key={`${row.id}-name-${row.full_name || ''}`}
                          defaultValue={row.full_name || ''}
                          placeholder="Full name"
                          disabled={busyId === row.id || !isAdmin}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v !== (row.full_name || '')) savePatch(row.id, { full_name: v })
                          }}
                          className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
                        />
                      </label>
                      <label className="block" title={isAdmin ? undefined : 'Admin only'}>
                        <span className="text-[11px] text-ink-3">Email</span>
                        <input
                          key={`${row.id}-email-${row.email || ''}`}
                          type="email"
                          defaultValue={row.email || ''}
                          placeholder="cleaner@email.com"
                          disabled={busyId === row.id || !isAdmin}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v !== (row.email || '')) savePatch(row.id, { email: v })
                          }}
                          className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <label className="block" title={isAdmin ? undefined : 'Admin only'}>
                        <span className="text-[11px] text-ink-3">Crew ID</span>
                        <input
                          key={`${row.id}-cid-${row.cleaner_id || ''}`}
                          defaultValue={row.cleaner_id || ''}
                          placeholder="—"
                          disabled={busyId === row.id || !isAdmin}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v !== (row.cleaner_id || '')) savePatch(row.id, { cleaner_id: v })
                          }}
                          className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
                        />
                      </label>
                      {rateInput(row, 'pay_rate_residential', row.pay_rate_residential, 'Residential $/hr')}
                      {rateInput(row, 'pay_rate_rental', row.pay_rate_rental, 'Rental $/hr')}
                      {rateInput(row, 'pay_rate_deep', row.pay_rate_deep, 'Deep $/hr')}
                    </div>
                    {/* Feeds Payroll's pre-calculated drive mileage (home → first
                        job → between houses). Kept here too, not just in Settings
                        → Users, so mileage isn't the one cleaner field that lives
                        on a different page than everything else about them. */}
                    <label className="block mt-2.5" title={isAdmin ? undefined : 'Admin only'}>
                      <span className="text-[11px] text-ink-3">Home address <span className="font-normal">(for payroll drive mileage)</span></span>
                      <input
                        key={`${row.id}-home-${row.home_address || ''}`}
                        defaultValue={row.home_address || ''}
                        placeholder="e.g. 12 Main St, Brunswick, ME"
                        disabled={busyId === row.id || !isAdmin}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          if (v !== (row.home_address || '')) savePatch(row.id, { home_address: v })
                        }}
                        className="mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
                      />
                    </label>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Add cleaner — kept below the roster: day-to-day the office reads/edits the roster; adding someone is the occasional flow.
            POST /api/crew is admin-only on the backend, so the whole form is
            disabled (not hidden — a manager should still see the option
            exists) for non-admins via the native <fieldset disabled>. */}
        <form onSubmit={addCleaner} className="border border-hairline bg-panel rounded-xl p-4">
          <fieldset disabled={!isAdmin} className="disabled:opacity-60">
          <div className="flex items-center gap-2 text-ink font-semibold text-sm mb-3">
            <UserPlus className="w-4 h-4 text-indigo-500" /> Add a cleaner
            {!isAdmin && <span className="text-[11px] font-normal text-ink-3">— admin only</span>}
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
              title={isAdmin ? undefined : 'Admin only'}
              className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md inline-flex items-center gap-1.5 transition-colors">
              <Mail className="w-4 h-4" /> {adding ? 'Sending…' : 'Add & send invite'}
            </button>
            <span className="text-[11px] text-ink-3">They’ll get an email with a link to set their password (good for 7 days).</span>
          </div>
          </fieldset>
        </form>

        <CrewDocsAdmin />
      </div>
      {thread && <OfficeCrewThread user={thread.user} initialDraft={thread.draft}
        onClose={() => setThread(null)} />}
    </div>
  )
}
