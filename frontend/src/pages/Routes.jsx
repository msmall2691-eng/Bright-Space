/**
 * Routes — a standing block of recurring work owned by one subcontractor
 * (marketplace pivot Phase 4, migration 100).
 *
 * The marketplace fits one-off work: post it, subs request it, the office
 * approves one. That is the wrong shape for recurring work, which is most of
 * the book — nobody wants to re-bid the same Tuesday house every week, and the
 * office does not want to re-approve it every week either. That is the "office
 * is the bottleneck" problem, one row at a time.
 *
 * A route is offered ONCE, accepted once, and then simply happens.
 *
 * OFFERED, NEVER ASSIGNED, and this screen has to make that visible rather
 * than merely obey it. There is no button here that puts a route in somebody's
 * hands — "Offer" sends it, and the row then reads "Offered · waiting on
 * <name>" until they accept in the crew app. A route somebody can decline is
 * work they chose, which is the difference between a subcontractor and an
 * employee with a nicer job title.
 *
 * THE MARGIN IS ON THE SCREEN. A route priced without the billed total next to
 * it is a route priced by feel, and the margin is what you lose that way.
 *
 * Reached from Schedule's tab strip, not the sidebar — that went 17 → 7
 * destinations deliberately.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Route as RouteIcon, Plus, Send, Trash2, Ban, ChevronDown, Check,
} from 'lucide-react'
import { get, post, patch, del } from '../api'
import { PageHeader, SubNav } from '../components/ui'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`)

// Dot + word. The owner has vetoed filled pills and count bubbles; status here
// is a colour and a sentence, same as everywhere else in the app.
const STATE = {
  draft: { dot: 'bg-ink-3/40', word: 'Draft' },
  offered: { dot: 'bg-amber-500', word: 'Offered' },
  active: { dot: 'bg-emerald-500', word: 'Active' },
  ended: { dot: 'bg-ink-3/40', word: 'Ended' },
}

function Status({ route }) {
  const s = STATE[route.status] || STATE.draft
  const suffix = route.status === 'offered'
    ? ` · waiting on ${route.owner_name || route.owner_cleaner_id}`
    : route.status === 'active'
      ? ` · ${route.owner_name || route.owner_cleaner_id}`
      : ''
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.word}{suffix}
    </span>
  )
}

export default function RoutesPage() {
  const [routes, setRoutes] = useState(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      setRoutes((await get('/api/routes')).routes)
      setError('')
    } catch (e) { setError(e?.detail || e?.message || String(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const create = async () => {
    setCreating(true)
    try {
      const r = await post('/api/routes', { name: 'New route', day_of_week: 1 })
      await load()
      setOpenId(r.id)     // straight into the detail — a draft with no houses
    } catch (e) {         // is not a thing to admire from the list
      toast.error(e?.detail || e?.message || 'Could not create that')
    } finally { setCreating(false) }
  }

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Routes"
        subtitle="A standing block of recurring work, owned by one subcontractor at one rate."
        icon={RouteIcon}
        iconColor="indigo"
      >
        <SubNav className="mb-3" />
        <button type="button" onClick={create} disabled={creating}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
          <Plus className="h-4 w-4" /> New route
        </button>
      </PageHeader>

      <div className="space-y-4 px-4 pb-6 sm:px-8">
        {error && (
          <p className="flex items-start gap-1.5 text-[13px] text-ink-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
            {error}
          </p>
        )}

        {routes === null ? (
          <div className="h-24 animate-pulse rounded-xl bg-bg-2" aria-hidden="true" />
        ) : routes.length === 0 ? (
          <div className="rounded-xl border border-hairline bg-panel p-6 text-[13px] text-ink-2">
            <p className="mb-1 font-medium text-ink">No routes yet.</p>
            <p className="text-ink-3">
              A route groups recurring houses into one day’s work at one price, so a
              subcontractor can plan a week instead of re-bidding the same Tuesday
              every Tuesday.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {routes.map(r => (
              <RouteCard key={r.id} route={r}
                open={openId === r.id}
                onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                onChanged={load} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One route. Collapsed it is a line; opened it fetches its own detail.
 *
 * REQUEST ECONOMY: the list endpoint carries names and counts, and the houses
 * (with their per-house share) arrive only when a route is actually opened.
 * Loading every route's members up front would be a dozen payloads to draw a
 * list nobody has drilled into.
 */
function RouteCard({ route, open, onToggle, onChanged }) {
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    get(`/api/routes/${route.id}`)
      .then(d => { if (alive) setDetail(d) })
      .catch(() => { if (alive) setDetail(false) })
    return () => { alive = false }
  }, [open, route.id])

  const run = async (label, fn) => {
    setBusy(label)
    try {
      const r = await fn()
      if (r && r.id) setDetail(r)
      await onChanged()
      return r
    } catch (e) {
      toast.error(e?.detail?.message || e?.detail || e?.message || 'That didn’t go through')
      return null
    } finally { setBusy('') }
  }

  const save = (body) => run('save', () => patch(`/api/routes/${route.id}`, body))

  const offer = async () => {
    const cleanerId = window.prompt('Offer this route to which crew ID?',
      route.owner_cleaner_id || '')
    if (!cleanerId) return
    // Check first, so conflicts and file problems are seen rather than
    // bounced back as an error after the fact.
    let check
    try {
      check = await get(`/api/routes/${route.id}/offer-check?cleaner_id=${encodeURIComponent(cleanerId)}`)
    } catch (e) {
      toast.error(e?.detail || 'Could not check that person')
      return
    }
    if (!check.known) { toast.error('That crew ID isn’t linked to anyone who can sign in.'); return }
    if (check.blocker) { toast.error(check.blocker); return }
    if (check.missing.length) {
      toast.error(`${check.cleaner_name} can’t take work yet — ${check.missing[0]}`)
      return
    }
    const lines = [`Offer this route to ${check.cleaner_name}?`]
    if (check.conflicts.length) {
      // Shown, not blocking: a clash on one date is a coverage question for
      // that date, not a reason to refuse a standing arrangement.
      lines.push(`${check.conflicts.length} of the next visits clash with work they already have.`)
    }
    lines.push('They can accept or decline — this does not assign it.')
    if (!await confirmDialog(lines.join('\n\n'), { title: 'Offer route', confirmLabel: 'Send offer' })) return
    await run('offer', () => post(`/api/routes/${route.id}/offer`, { cleaner_id: cleanerId }))
  }

  const end = async () => {
    if (!await confirmDialog(
      'It stops generating new visits. Visits already on the calendar keep their '
      + 'owner and their price — ending a route is about the future.',
      { title: 'End this route', confirmLabel: 'End route' })) return
    await run('end', () => post(`/api/routes/${route.id}/end`, {}))
  }

  const remove = async () => {
    if (!await confirmDialog('It has never been offered to anyone.',
      { title: 'Delete this draft', confirmLabel: 'Delete', danger: true })) return
    await run('delete', () => del(`/api/routes/${route.id}`))
  }

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-panel">
      <button type="button" onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-2/60">
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{route.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
            <span>{DAYS[route.day_of_week] || '—'}</span>
            <span>{route.member_count} house{route.member_count === 1 ? '' : 's'}</span>
            <span>{money(route.rate)} per week</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Status route={route} />
          <ChevronDown className={`h-4 w-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-hairline px-4 py-3">
          {detail === null ? (
            <div className="h-16 animate-pulse rounded-lg bg-bg-2" aria-hidden="true" />
          ) : detail === false ? (
            <p className="text-[13px] text-ink-3">Couldn’t load this route just now.</p>
          ) : (
            <RouteDetail detail={detail} busy={busy} onSave={save}
              onOffer={offer} onEnd={end} onDelete={remove} />
          )}
        </div>
      )}
    </div>
  )
}

function RouteDetail({ detail, busy, onSave, onOffer, onEnd, onDelete }) {
  const [name, setName] = useState(detail.name)
  const [rate, setRate] = useState(detail.rate ?? '')
  const [day, setDay] = useState(detail.day_of_week)
  const editable = detail.status !== 'ended'

  const commit = () => {
    const body = {}
    if (name !== detail.name) body.name = name
    if (Number(rate) !== Number(detail.rate ?? 0)) body.rate = Number(rate) || 0
    if (Number(day) !== detail.day_of_week) body.day_of_week = Number(day)
    if (Object.keys(body).length) onSave(body)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[180px] flex-1">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-3">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} onBlur={commit}
            disabled={!editable}
            className="w-full rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-blue-400/30 disabled:opacity-60" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-3">Day</span>
          <select value={day} onChange={e => setDay(e.target.value)} onBlur={commit}
            disabled={!editable}
            className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] text-ink focus:outline-none disabled:opacity-60">
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </label>
        <label className="w-32">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-3">
            Pays per week
          </span>
          <input type="number" step="any" value={rate} onChange={e => setRate(e.target.value)}
            onBlur={commit} disabled={!editable}
            className="w-full rounded-lg border border-hairline bg-panel px-3 py-1.5 text-right text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-blue-400/30 disabled:opacity-60" />
        </label>
      </div>

      {detail.blocker && (
        <p className="flex items-start gap-1.5 text-[12px] text-ink-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          {detail.blocker}
        </p>
      )}

      {detail.members.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-hairline">
          <table className="w-full min-w-[380px] text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-1.5 text-left font-medium">House</th>
                <th className="px-3 py-1.5 text-left font-medium">Window</th>
                <th className="px-3 py-1.5 text-right font-medium">Their share</th>
              </tr>
            </thead>
            <tbody>
              {detail.members.map(m => (
                <tr key={m.recurring_schedule_id} className="border-b border-hairline/60 last:border-0">
                  <td className="px-3 py-1.5 text-ink">{m.title}</td>
                  <td className="px-3 py-1.5 text-ink-3">
                    {m.start_time && m.end_time
                      ? `${m.start_time.slice(0, 5)}–${m.end_time.slice(0, 5)}`
                      : 'no time set'}
                  </td>
                  <td className="px-3 py-1.5 text-right text-ink">{money(m.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[12px] text-ink-3">
        The block price splits across the houses by how long each one takes, and the
        shares add up to the block price exactly. A 90-minute house and a 3-hour house
        are not the same work.
      </p>

      <MarginLine billing={detail.billing} rate={detail.rate} />

      <div className="flex flex-wrap items-center gap-2">
        {['draft', 'offered'].includes(detail.status) && (
          <button type="button" onClick={onOffer} disabled={busy === 'offer'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-bg-2 disabled:opacity-50">
            <Send className="h-3.5 w-3.5" />
            {detail.status === 'offered' ? 'Offer to someone else' : 'Offer to a sub'}
          </button>
        )}
        {detail.status === 'active' && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
            <Check className="h-3.5 w-3.5" /> Accepted — visits generate to this owner at this price.
          </span>
        )}
        {['offered', 'active'].includes(detail.status) && (
          <button type="button" onClick={onEnd} disabled={busy === 'end'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-3 transition-colors hover:bg-bg-2 disabled:opacity-50">
            <Ban className="h-3.5 w-3.5" /> End route
          </button>
        )}
        {detail.status === 'draft' && (
          <button type="button" onClick={onDelete} disabled={busy === 'delete'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[13px] font-medium text-ink-3 transition-colors hover:bg-bg-2 disabled:opacity-50">
            <Trash2 className="h-3.5 w-3.5" /> Delete draft
          </button>
        )}
      </div>
    </div>
  )
}


/**
 * Billed vs paid out, from real invoices.
 *
 * Says "not invoiced yet" rather than showing a margin when there is nothing
 * to compute one from. The cheerful version of an unknown number — 100% margin
 * on a route nobody has billed — is the dangerous one, and it is exactly the
 * number somebody would price the next route against.
 */
function MarginLine({ billing, rate }) {
  if (!billing || billing.billed == null) {
    return (
      <p className="text-[12px] text-ink-3">
        No completed, invoiced visits on these houses yet — so there is no billed
        total to price this against.
      </p>
    )
  }
  const thin = billing.margin_pct != null && billing.margin_pct < 20
  return (
    <p className="flex items-start gap-1.5 text-[12px] text-ink-2">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
        thin ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
      <span>
        Bills {money(billing.billed)} a week (average of the last{' '}
        {billing.occurrences} {billing.occurrences === 1 ? 'week' : 'weeks'}), pays{' '}
        {money(rate)} — {money(billing.margin)} left
        {billing.margin_pct != null && `, ${billing.margin_pct}%`}.
      </span>
    </p>
  )
}
