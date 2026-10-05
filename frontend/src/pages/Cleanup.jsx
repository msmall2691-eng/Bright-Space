/**
 * Tidy Up — review and resolve the messes intake-time dedup can't reach:
 * duplicate clients (merge them), duplicate properties, and data-quality gaps.
 * Backed by GET /api/cleanup/scan + POST /api/cleanup/clients/merge.
 *
 * Merge is hard to undo, so it's a two-step confirm and you choose which record
 * survives (the richest one is pre-selected). Built on the app's theme tokens.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users, Home, AlertTriangle, GitMerge, RotateCcw, Check, ArrowRight,
  Loader2, Sparkles, Phone, Mail, MapPin,
} from 'lucide-react'
import { get, post } from '../api'
import { ErrorState } from '../components/ui'
import PageTitle from '../components/ui/PageTitle'
import { SEV_DOT } from '../components/board/tokens'

const CARD = 'rounded-2xl border border-hairline bg-panel'

// How many duplicate groups to show before folding the rest. A business with
// twenty duplicate groups got twenty expanded cards and an unbounded scroll;
// this is a triage surface, so it shows a screenful and defers the tail
// (brightbase-ui-revamp: "cap and defer").
const GROUP_CAP = 6

/** "Mar 12, 2025" — which record is the original. */
function added(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Client lifecycle, as a dot + word. It matters for a merge: folding an ACTIVE
// client into a lead loses the one that has the history.
const STATUS_DOT = {
  active: SEV_DOT.good,
  lead: SEV_DOT.info,
  inactive: 'bg-ink-3',
}

/** Split a list into two packing columns. A 2-up CSS grid would tie every card
 *  in a row to the tallest (a 2-record group beside a 5-record one leaves dead
 *  space — the owner's "too much empty spaces"); two flex stacks let a short
 *  card sit directly on the next. */
function columns(list) {
  const a = []
  const b = []
  list.forEach((item, i) => (i % 2 ? b : a).push(item))
  return [a, b]
}

function Stat({ icon: Icon, n, label }) {
  return (
    <div className={`${CARD} flex items-center gap-3 px-4 py-3`}>
      <Icon className="h-4 w-4 shrink-0 text-ink-3" />
      <div>
        <div className="text-xl font-bold leading-none tabular-nums text-ink">{n}</div>
        <div className="text-[11px] text-ink-3">{label}</div>
      </div>
    </div>
  )
}

function ClientRow({ c, isPrimary, onPick }) {
  // The focus ring comes from :focus-within, not .bb-focus — focus lands on the
  // radio INSIDE this label, so a :focus-visible rule on the label itself never
  // fires. Same 2px accent ring, inset so the card's rounding cannot clip it.
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent ${
      isPrimary ? 'border-indigo-400 bg-indigo-500/5' : 'border-hairline hover:border-hairline-2'
    }`}>
      <input type="radio" checked={isPrimary} onChange={onPick} className="mt-1 accent-indigo-600" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">{c.name}</span>
          {isPrimary
            ? <span className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide text-ink-2"><span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />Keep</span>
            : <span className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide text-ink-3"><span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT.urgent}`} aria-hidden="true" />Merge in</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
          {c.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{c.email}</span>}
          {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</span>}
          {c.address && <span className="inline-flex items-center gap-1 truncate"><MapPin className="h-3 w-3" />{c.address}</span>}
        </div>
        {/* `status` and `created_at` have ridden this payload since the scan
            shipped and nothing rendered either — on the one screen whose whole
            job is "which of these do I keep". The date answers "which is the
            original" and the status stops you folding an active client into a
            lead. Free: same response. */}
        {(c.status || c.created_at) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
            {c.status && (
              <span className="inline-flex items-center gap-1.5 capitalize">
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[c.status] || 'bg-ink-3'}`} aria-hidden="true" />
                {c.status}
              </span>
            )}
            {added(c.created_at) && <span>added {added(c.created_at)}</span>}
          </div>
        )}
        <div className="mt-1 text-[10.5px] text-ink-3">
          {c.record_total} record{c.record_total === 1 ? '' : 's'} · {c.records.jobs || 0} jobs · {c.records.invoices || 0} invoices · {c.records.quotes || 0} quotes · {c.records.properties || 0} properties
        </div>
      </div>
    </label>
  )
}

function PropRow({ p, isPrimary, onPick }) {
  // The focus ring comes from :focus-within, not .bb-focus — focus lands on the
  // radio INSIDE this label, so a :focus-visible rule on the label itself never
  // fires. Same 2px accent ring, inset so the card's rounding cannot clip it.
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent ${
      isPrimary ? 'border-indigo-400 bg-indigo-500/5' : 'border-hairline hover:border-hairline-2'
    }`}>
      <input type="radio" checked={isPrimary} onChange={onPick} className="mt-1 accent-indigo-600" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">{p.name || '(unnamed)'}</span>
          {isPrimary
            ? <span className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide text-ink-2"><span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />Keep</span>
            : <span className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide text-ink-3"><span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT.urgent}`} aria-hidden="true" />Merge in</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
          {p.client_name && <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{p.client_name}</span>}
          {p.property_type && <span className="capitalize">{p.property_type}</span>}
        </div>
      </div>
    </label>
  )
}

export default function Cleanup() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [primaryBy, setPrimaryBy] = useState({})
  const [primaryPropBy, setPrimaryPropBy] = useState({})
  const [confirmKey, setConfirmKey] = useState(null)
  const [busyKey, setBusyKey] = useState(null)
  const [note, setNote] = useState('')
  const [showAllClients, setShowAllClients] = useState(false)
  const [showAllProps, setShowAllProps] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setData(await get('/api/cleanup/scan')); setError(false) }
    catch { setError(true) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const primaryFor = (g) => primaryBy[g.key] ?? g.clients[0].id

  async function doMerge(g) {
    const primaryId = primaryFor(g)
    const dups = g.clients.filter(c => c.id !== primaryId)
    const primaryName = g.clients.find(c => c.id === primaryId)?.name || 'client'
    setBusyKey(g.key)
    let done = 0
    try {
      for (const d of dups) {
        await post('/api/cleanup/clients/merge', { primary_id: primaryId, duplicate_id: d.id })
        done += 1
      }
      // All merged — drop the resolved group locally.
      setData(prev => ({
        ...prev,
        duplicate_clients: prev.duplicate_clients.filter(x => x.key !== g.key),
        summary: { ...prev.summary, duplicate_client_groups: Math.max(0, prev.summary.duplicate_client_groups - 1) },
      }))
      setNote(`Merged ${done} duplicate${done === 1 ? '' : 's'} into ${primaryName}.`)
    } catch {
      // A merge partway through a 3+ group failed AFTER earlier ones already
      // committed (those can't be undone). Don't claim "nothing changed" —
      // report the partial result and rescan so the half-merged group refreshes
      // (a retry would otherwise fail on the already-deleted duplicate).
      if (done > 0) {
        setNote(`Merged ${done} of ${dups.length} into ${primaryName}, then hit an error — rescanning.`)
        await load()
      } else {
        setNote('Merge failed — nothing was changed. Try again.')
      }
    } finally {
      setBusyKey(null); setConfirmKey(null)
    }
  }

  const primaryPropFor = (g) => primaryPropBy[g.key] ?? g.properties[0].id
  // Only same-client properties are true duplicates — a shared address across
  // two clients isn't one, and the backend refuses that merge.
  const propDupsFor = (g) => {
    const keeper = g.properties.find(p => p.id === primaryPropFor(g)) || g.properties[0]
    return g.properties.filter(p => p.id !== keeper.id && p.client_id === keeper.client_id)
  }

  async function doMergeProps(g) {
    const primaryId = primaryPropFor(g)
    const keeper = g.properties.find(p => p.id === primaryId)
    const dups = propDupsFor(g)
    setBusyKey(g.key)
    let done = 0
    try {
      for (const d of dups) {
        await post('/api/cleanup/properties/merge', { primary_id: primaryId, duplicate_id: d.id })
        done += 1
      }
      setData(prev => ({
        ...prev,
        duplicate_properties: prev.duplicate_properties.filter(x => x.key !== g.key),
        summary: { ...prev.summary, duplicate_property_groups: Math.max(0, prev.summary.duplicate_property_groups - 1) },
      }))
      setNote(`Merged ${done} duplicate propert${done === 1 ? 'y' : 'ies'} into ${keeper?.name || 'the keeper'}.`)
    } catch (e) {
      // A turnover-overlap 409 (or any mid-loop failure after earlier merges
      // committed) — report honestly and rescan so the group refreshes.
      if (done > 0) {
        setNote(`Merged ${done} of ${dups.length}, then hit an error — rescanning.`)
        await load()
      } else {
        setNote(e?.message || 'Merge failed — nothing was changed. Try again.')
      }
    } finally {
      setBusyKey(null); setConfirmKey(null)
    }
  }

  if (error && !loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <ErrorState title="Couldn't run the scan"
          description="The server didn't respond. Try again." onRetry={load} />
      </div>
    )
  }

  const dupClients = data?.duplicate_clients || []
  const dupProps = data?.duplicate_properties || []
  const quality = data?.quality || { no_contact: { count: 0, samples: [] }, no_property: { count: 0, samples: [] } }
  const mismatch = quality.client_property_mismatch || { count: 0, samples: [] }
  const s = data?.summary || {}

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-5 sm:px-6">
      <PageTitle
        icon={Sparkles}
        title="Tidy Up"
        subtitle={`Find duplicate clients & properties and clean up messy records.${data ? ` Scanned ${data.scanned.clients} clients · ${data.scanned.properties} properties.` : ''}`}
        actions={
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] font-semibold text-ink-2 hover:text-ink disabled:opacity-50">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Rescan
          </button>
        }
      />

      {note && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-hairline bg-panel px-3 py-2 text-[12px] font-medium text-ink-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT.good}`} aria-hidden="true" /> {note}
        </div>
      )}

      {loading ? (
        <div className="mt-5 space-y-3">
          {[0, 1, 2].map(i => <div key={i} className="h-28 animate-pulse rounded-2xl border border-hairline bg-panel" />)}
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat icon={Users} n={s.duplicate_client_groups || 0} label="duplicate client groups" />
            <Stat icon={Home} n={s.duplicate_property_groups || 0} label="duplicate property groups" />
            <Stat icon={AlertTriangle} n={s.quality_flags || 0} label="data-quality flags" />
          </div>

          {/* Duplicate clients. No all-clear card: this section used to keep a
              permanent "No duplicate clients found" panel where its own two
              siblings below self-suppress, which trains you to skip the spot the
              real thing appears in. When everything is clean the page says so
              once, at the bottom. */}
          {dupClients.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
              <Users className="h-4 w-4 text-ink-3" /> Duplicate clients
              <span className="text-[11px] font-medium text-ink-3 tabular-nums">{dupClients.length}</span>
            </h2>
              <div className="grid grid-cols-1 items-start gap-3 shell:grid-cols-2">
                {columns(showAllClients ? dupClients : dupClients.slice(0, GROUP_CAP)).map((col, ci) => (
                <div key={ci} className="flex min-w-0 flex-col gap-3">
                {col.map(g => {
                  const primaryId = primaryFor(g)
                  const dupsCount = g.clients.length - 1
                  return (
                    <div key={g.key} className={`${CARD} p-3.5`}>
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3">
                          matched on {g.reason}
                        </span>
                        <span className="text-[11px] text-ink-3">{g.clients.length} records</span>
                      </div>
                      <div className="space-y-2">
                        {g.clients.map(c => (
                          <ClientRow key={c.id} c={c} isPrimary={c.id === primaryId}
                            onPick={() => setPrimaryBy(p => ({ ...p, [g.key]: c.id }))} />
                        ))}
                      </div>
                      <div className="mt-3 flex items-center justify-end gap-2">
                        {confirmKey === g.key ? (
                          <>
                            <span className="mr-auto text-[11px] font-medium text-rose-700 dark:text-rose-300">
                              This can't be undone.
                            </span>
                            <button onClick={() => setConfirmKey(null)}
                              className="rounded-lg border border-hairline px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:text-ink">
                              Cancel
                            </button>
                            <button onClick={() => doMerge(g)} disabled={busyKey === g.key}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-rose-700 disabled:opacity-60">
                              {busyKey === g.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
                              Merge {dupsCount} into keep
                            </button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmKey(g.key)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:text-ink">
                            <GitMerge className="h-3.5 w-3.5" /> Merge duplicates
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
                </div>
                ))}
              </div>
              {dupClients.length > GROUP_CAP && (
                <button onClick={() => setShowAllClients(v => !v)}
                  className="bb-focus mt-3 w-full rounded-xl border border-hairline bg-panel px-3 py-2 text-[12px] font-semibold text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2">
                  {showAllClients
                    ? 'Show fewer'
                    : `+${dupClients.length - GROUP_CAP} more duplicate group${dupClients.length - GROUP_CAP === 1 ? '' : 's'}`}
                </button>
              )}
          </section>
          )}

          {/* Duplicate properties */}
          {dupProps.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
                <Home className="h-4 w-4 text-ink-3" /> Duplicate properties
                <span className="text-[11px] font-medium text-ink-3 tabular-nums">{dupProps.length}</span>
              </h2>
              <div className="grid grid-cols-1 items-start gap-3 shell:grid-cols-2">
                {columns(showAllProps ? dupProps : dupProps.slice(0, GROUP_CAP)).map((col, ci) => (
                <div key={ci} className="flex min-w-0 flex-col gap-3">
                {col.map(g => {
                  const primaryId = primaryPropFor(g)
                  const dups = propDupsFor(g)
                  const crossClient = g.properties.length - 1 - dups.length
                  return (
                    <div key={g.key} className={`${CARD} p-3.5`}>
                      <div className="mb-2 text-[13px] font-semibold text-ink">{g.address}</div>
                      <div className="space-y-2">
                        {g.properties.map(p => (
                          <PropRow key={p.id} p={p} isPrimary={p.id === primaryId}
                            onPick={() => setPrimaryPropBy(m => ({ ...m, [g.key]: p.id }))} />
                        ))}
                      </div>
                      {crossClient > 0 && (
                        <p className="mt-2 text-[11px] text-ink-3">
                          {crossClient} here belong{crossClient === 1 ? 's' : ''} to a different client and won't merge — merge those clients first, or open each to check.
                        </p>
                      )}
                      <div className="mt-3 flex items-center justify-end gap-2">
                        {dups.length === 0 ? (
                          <button onClick={() => navigate(`/properties/${primaryId}`)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:text-ink">
                            Open to review <ArrowRight className="h-3.5 w-3.5" />
                          </button>
                        ) : confirmKey === g.key ? (
                          <>
                            <span className="mr-auto text-[11px] font-medium text-rose-700 dark:text-rose-300">
                              This can't be undone.
                            </span>
                            <button onClick={() => setConfirmKey(null)}
                              className="rounded-lg border border-hairline px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:text-ink">
                              Cancel
                            </button>
                            <button onClick={() => doMergeProps(g)} disabled={busyKey === g.key}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-rose-700 disabled:opacity-60">
                              {busyKey === g.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
                              Merge {dups.length} into keep
                            </button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmKey(g.key)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:text-ink">
                            <GitMerge className="h-3.5 w-3.5" /> Merge duplicates
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
                </div>
                ))}
              </div>
              {dupProps.length > GROUP_CAP && (
                <button onClick={() => setShowAllProps(v => !v)}
                  className="bb-focus mt-3 w-full rounded-xl border border-hairline bg-panel px-3 py-2 text-[12px] font-semibold text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2">
                  {showAllProps
                    ? 'Show fewer'
                    : `+${dupProps.length - GROUP_CAP} more address${dupProps.length - GROUP_CAP === 1 ? '' : 'es'}`}
                </button>
              )}
            </section>
          )}

          {/* Data-quality */}
          {(quality.no_contact.count > 0 || quality.no_property.count > 0 || mismatch.count > 0) && (
            <section className="mt-8">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
                <AlertTriangle className="h-4 w-4 text-ink-3" /> Needs attention
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  { key: 'no_contact', label: 'No email or phone', q: quality.no_contact },
                  { key: 'no_property', label: 'Active, no property on file', q: quality.no_property },
                ].filter(x => x.q.count > 0).map(x => (
                  <div key={x.key} className={`${CARD} p-3.5`}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-bold tabular-nums text-ink">{x.q.count}</span>
                      <span className="text-[12px] font-medium text-ink-2">{x.label}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {x.q.samples.map(c => (
                        <button key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
                          className="rounded-md border border-hairline px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink hover:bg-bg-2">
                          {c.name}
                        </button>
                      ))}
                      {x.q.count > x.q.samples.length && (
                        <span className="px-1 py-0.5 text-[11px] text-ink-3">+{x.q.count - x.q.samples.length} more</span>
                      )}
                    </div>
                  </div>
                ))}
                {mismatch.count > 0 && (
                  <div className={`${CARD} p-3.5 sm:col-span-2`}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-bold tabular-nums text-ink">{mismatch.count}</span>
                      <span className="text-[12px] font-medium text-ink-2">Job assigned to a property owned by a different client</span>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-3">
                      These live jobs point at a client that isn't the one who owns the property. Open the property to fix the link.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {mismatch.samples.map(m => (
                        <button key={m.job_id} onClick={() => navigate(`/properties/${m.property_id}`)}
                          title={`Job says ${m.job_client} · property says ${m.property_client}`}
                          className="rounded-md border border-hairline px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink hover:bg-bg-2">
                          {m.title}
                        </button>
                      ))}
                      {mismatch.count > mismatch.samples.length && (
                        <span className="px-1 py-0.5 text-[11px] text-ink-3">+{mismatch.count - mismatch.samples.length} more</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Said ONCE, when there is genuinely nothing to do — not a card per
              section. Three all-clear panels on a clean install is furniture
              that teaches you to skip the place the real finding appears. */}
          {dupClients.length === 0 && dupProps.length === 0
            && quality.no_contact.count === 0 && quality.no_property.count === 0
            && mismatch.count === 0 && (
            <div className={`${CARD} mt-8 px-4 py-10 text-center`}>
              <Check className={`mx-auto h-6 w-6 ${SEV_DOT.good.split(' ')[0].replace('bg-', 'text-')}`} />
              <p className="mt-2 text-sm font-semibold text-ink">Nothing to tidy up</p>
              <p className="text-[12px] text-ink-3">
                No duplicate clients or properties, and no records missing contact details.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
