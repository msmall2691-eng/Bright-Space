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

const CARD = 'rounded-2xl border border-hairline bg-panel'

function Stat({ icon: Icon, tint, n, label }) {
  return (
    <div className={`${CARD} flex items-center gap-3 px-4 py-3`}>
      <span className={`grid h-9 w-9 place-items-center rounded-xl ${tint}`}><Icon className="h-4 w-4" /></span>
      <div>
        <div className="text-xl font-bold leading-none tabular-nums text-ink">{n}</div>
        <div className="text-[11px] text-ink-3">{label}</div>
      </div>
    </div>
  )
}

function ClientRow({ c, isPrimary, onPick }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
      isPrimary ? 'border-indigo-400 bg-indigo-500/5' : 'border-hairline hover:border-hairline-2'
    }`}>
      <input type="radio" checked={isPrimary} onChange={onPick} className="mt-1 accent-indigo-600" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">{c.name}</span>
          {isPrimary
            ? <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">Keep</span>
            : <span className="rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-300">Merge in</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
          {c.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{c.email}</span>}
          {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</span>}
          {c.address && <span className="inline-flex items-center gap-1 truncate"><MapPin className="h-3 w-3" />{c.address}</span>}
        </div>
        <div className="mt-1 text-[10.5px] text-ink-3">
          {c.record_total} record{c.record_total === 1 ? '' : 's'} · {c.records.jobs || 0} jobs · {c.records.invoices || 0} invoices · {c.records.quotes || 0} quotes · {c.records.properties || 0} properties
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
  const [confirmKey, setConfirmKey] = useState(null)
  const [busyKey, setBusyKey] = useState(null)
  const [note, setNote] = useState('')

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
    setBusyKey(g.key)
    try {
      for (const d of dups) {
        await post('/api/cleanup/clients/merge', { primary_id: primaryId, duplicate_id: d.id })
      }
      setData(prev => ({
        ...prev,
        duplicate_clients: prev.duplicate_clients.filter(x => x.key !== g.key),
        summary: { ...prev.summary, duplicate_client_groups: Math.max(0, prev.summary.duplicate_client_groups - 1) },
      }))
      const primaryName = g.clients.find(c => c.id === primaryId)?.name || 'client'
      setNote(`Merged ${dups.length} duplicate${dups.length === 1 ? '' : 's'} into ${primaryName}.`)
    } catch {
      setNote('Merge failed — nothing was changed. Try again.')
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
  const s = data?.summary || {}

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-5 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-500" />
            <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">Tidy Up</h1>
          </div>
          <p className="mt-0.5 text-[13px] text-ink-3">
            Find duplicate clients &amp; properties and clean up messy records.
            {data && <> Scanned {data.scanned.clients} clients · {data.scanned.properties} properties.</>}
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] font-semibold text-ink-2 hover:text-ink disabled:opacity-50">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Rescan
        </button>
      </header>

      {note && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
          <Check className="h-4 w-4" /> {note}
        </div>
      )}

      {loading ? (
        <div className="mt-5 space-y-3">
          {[0, 1, 2].map(i => <div key={i} className="h-28 animate-pulse rounded-2xl border border-hairline bg-panel" />)}
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat icon={Users} tint="bg-rose-500/10 text-rose-600 dark:text-rose-300" n={s.duplicate_client_groups || 0} label="duplicate client groups" />
            <Stat icon={Home} tint="bg-amber-500/10 text-amber-600 dark:text-amber-300" n={s.duplicate_property_groups || 0} label="duplicate property groups" />
            <Stat icon={AlertTriangle} tint="bg-blue-500/10 text-blue-600 dark:text-blue-300" n={s.quality_flags || 0} label="data-quality flags" />
          </div>

          {/* Duplicate clients */}
          <section className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
              <Users className="h-4 w-4 text-ink-3" /> Duplicate clients
            </h2>
            {dupClients.length === 0 ? (
              <div className={`${CARD} px-4 py-8 text-center`}>
                <Check className="mx-auto h-6 w-6 text-emerald-500" />
                <p className="mt-2 text-sm font-semibold text-ink">No duplicate clients found</p>
                <p className="text-[12px] text-ink-3">Your client list looks clean.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {dupClients.map(g => {
                  const primaryId = primaryFor(g)
                  const dupsCount = g.clients.length - 1
                  return (
                    <div key={g.key} className={`${CARD} p-3.5`}>
                      <div className="mb-2 flex items-center gap-2">
                        <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-300">
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
                            <span className="mr-auto text-[11px] font-medium text-rose-600 dark:text-rose-300">
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
            )}
          </section>

          {/* Duplicate properties */}
          {dupProps.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
                <Home className="h-4 w-4 text-ink-3" /> Duplicate properties
              </h2>
              <div className="space-y-3">
                {dupProps.map(g => (
                  <div key={g.key} className={`${CARD} p-3.5`}>
                    <div className="text-[13px] font-semibold text-ink">{g.address}</div>
                    <div className="mt-2 space-y-1.5">
                      {g.properties.map(p => (
                        <button key={p.id} onClick={() => navigate(`/properties/${p.id}`)}
                          className="flex w-full items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-left hover:border-hairline-2">
                          <span className="text-[12px] text-ink">{p.name || g.address}</span>
                          {p.client_name && <span className="text-[11px] text-ink-3">· {p.client_name}</span>}
                          <ArrowRight className="ml-auto h-3.5 w-3.5 text-ink-3" />
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-ink-3">Open each to confirm, then keep the right one.</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Data-quality */}
          {(quality.no_contact.count > 0 || quality.no_property.count > 0) && (
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
                          className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink">
                          {c.name}
                        </button>
                      ))}
                      {x.q.count > x.q.samples.length && (
                        <span className="px-1 py-0.5 text-[11px] text-ink-3">+{x.q.count - x.q.samples.length} more</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
