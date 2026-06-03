import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Trash2, CheckCircle, AlertCircle, Link as LinkIcon, X, ChevronDown } from 'lucide-react'
import { get, post, del } from '../api'

const SOURCES = [
  { value: 'airbnb',     label: 'Airbnb',      pattern: /airbnb\.com/i },
  { value: 'vrbo',       label: 'VRBO',        pattern: /vrbo\.com|homeaway\./i },
  { value: 'booking_com', label: 'Booking.com', pattern: /booking\.com/i },
  { value: 'manual',     label: 'Manual / Custom' },
]

function detectSource(url) {
  for (const s of SOURCES) {
    if (s.pattern && s.pattern.test(url)) return s.value
  }
  return 'manual'
}

function normalizeUrl(raw) {
  let u = (raw || '').trim()
  if (!u) return ''
  if (u.startsWith('webcal://')) u = 'https://' + u.slice(9)
  if (u.startsWith('http://')) u = 'https://' + u.slice(7)
  return u
}

const INPUT = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400'

export default function PropertyIcalsBulk() {
  const { propertyId } = useParams()
  const navigate = useNavigate()

  const [property, setProperty] = useState(null)
  const [loading, setLoading] = useState(true)
  const [paste, setPaste] = useState('')
  const [defaults, setDefaults] = useState({ checkout_time: '', duration_hours: '' })
  const [showDefaults, setShowDefaults] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addResults, setAddResults] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [perRowSource, setPerRowSource] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const p = await get(`/api/properties/${propertyId}`)
      setProperty(p)
    } catch (e) {
      console.error('[PropertyIcalsBulk load]', e)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [propertyId])

  // Parse pasted URLs into rows. Each non-empty line becomes a candidate;
  // we dedupe against URLs already on the property (case-insensitive).
  const existingUrls = useMemo(
    () => new Set((property?.icals || []).map(i => (i.url || '').trim().toLowerCase())),
    [property]
  )

  const parsedRows = useMemo(() => {
    return paste
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((raw, idx) => {
        const url = normalizeUrl(raw)
        const source = perRowSource[idx] ?? detectSource(url)
        const duplicate = existingUrls.has(url.toLowerCase())
        const valid = /^https?:\/\/.+/.test(url)
        return { idx, raw, url, source, duplicate, valid }
      })
  }, [paste, perRowSource, existingUrls])

  const addAll = async () => {
    const toAdd = parsedRows.filter(r => r.valid && !r.duplicate)
    if (toAdd.length === 0) return
    setAdding(true)
    setAddResults(null)
    const results = []
    for (const row of toAdd) {
      const body = { url: row.url, source: row.source }
      if (defaults.checkout_time) body.checkout_time = defaults.checkout_time
      if (defaults.duration_hours) body.duration_hours = parseFloat(defaults.duration_hours)
      try {
        await post(`/api/properties/${propertyId}/icals`, body)
        results.push({ url: row.url, ok: true })
      } catch (e) {
        results.push({ url: row.url, ok: false, error: e?.message || 'failed' })
      }
    }
    setAddResults(results)
    setPaste('')
    setPerRowSource({})
    await load()
    setAdding(false)
  }

  const removeFeed = async (icalId) => {
    if (!confirm('Remove this calendar feed?')) return
    try {
      await del(`/api/properties/${propertyId}/icals/${icalId}`)
      await load()
    } catch (e) {
      alert('Could not remove feed: ' + (e?.message || 'unknown'))
    }
  }

  const sync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const data = await post(`/api/properties/${propertyId}/sync`)
      const jobs = data?.jobs_created ?? 0
      setSyncResult({ ok: true, message: jobs > 0 ? `Synced — ${jobs} new turnover${jobs === 1 ? '' : 's'} scheduled` : 'Synced — no new turnovers' })
      await load()
    } catch (e) {
      setSyncResult({ ok: false, message: e?.message || 'Sync failed' })
    }
    setSyncing(false)
  }

  // Retry a single feed without re-syncing the whole property — handy when one
  // feed is failing (bad URL / outage) but the others are fine.
  const [syncingFeed, setSyncingFeed] = useState(null)
  const syncFeed = async (icalId) => {
    setSyncingFeed(icalId)
    setSyncResult(null)
    try {
      const data = await post(`/api/properties/${propertyId}/icals/${icalId}/sync`)
      const jobs = data?.jobs_created ?? 0
      setSyncResult({ ok: true, message: jobs > 0 ? `Feed synced — ${jobs} new turnover${jobs === 1 ? '' : 's'}` : 'Feed synced — no new turnovers' })
      await load()
    } catch (e) {
      setSyncResult({ ok: false, message: e?.message || 'Feed sync failed' })
    }
    setSyncingFeed(null)
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full text-sm text-ink-3">Loading property…</div>
  }
  if (!property) {
    return (
      <div className="p-6 text-sm text-ink-3">
        Property not found. <button onClick={() => navigate('/properties')} className="text-blue-600 underline">Back to Properties</button>
      </div>
    )
  }

  const isStr = (property.property_type || '').toLowerCase() === 'str'
  const validRows = parsedRows.filter(r => r.valid && !r.duplicate)

  return (
    <div className="flex flex-col h-full overflow-y-auto sm:overflow-hidden" data-testid="property-icals-bulk">
      <div className="bg-panel border-b border-hairline px-4 sm:px-6 py-4 shrink-0">
        <button onClick={() => navigate(`/properties/${propertyId}`)}
          className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2 mb-2">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to property
        </button>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-ink truncate">{property.name}</h1>
            <p className="text-xs text-ink-3 mt-0.5">
              {[property.address, property.city, property.state].filter(Boolean).join(', ')}
            </p>
            {!isStr && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-2 inline-block">
                Note: this property's type is <strong>{property.property_type}</strong> — iCal feeds only auto-create turnovers on STR properties.
              </p>
            )}
          </div>
          <button onClick={sync}
            disabled={syncing || (property.icals?.length || 0) === 0}
            data-testid="bulk-sync"
            className="flex items-center gap-1.5 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 text-amber-700 border border-amber-200 px-3 py-1.5 rounded-lg text-sm transition-colors shrink-0">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        {syncResult && (
          <div className={`mt-3 flex items-start gap-2 rounded-lg p-2.5 text-xs border ${syncResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {syncResult.ok ? <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <span className="flex-1">{syncResult.message}</span>
            <button onClick={() => setSyncResult(null)} className="opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
          </div>
        )}
      </div>

      <div className="p-4 sm:p-6 pb-28 sm:pb-6 sm:flex-1 sm:overflow-y-auto space-y-6 max-w-2xl mx-auto w-full">
        {/* Existing feeds */}
        <section data-testid="existing-feeds">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-3 mb-2">Current feeds</h2>
          {(property.icals?.length || 0) === 0 ? (
            <p className="text-sm text-ink-3 italic bg-bg border border-hairline rounded-lg px-3 py-2.5">No calendar feeds yet.</p>
          ) : (
            <ul className="space-y-2">
              {property.icals.map(ical => (
                <li key={ical.id} className="bg-panel border border-hairline rounded-lg p-3" data-testid="existing-feed-row">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                          {SOURCES.find(s => s.value === (ical.source || '').toLowerCase())?.label || ical.source || 'Custom'}
                        </span>
                        {ical.last_sync_status === 'failed' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-50 text-red-700" title={ical.last_sync_error || ''}>
                            <AlertCircle className="w-2.5 h-2.5" /> Failed
                          </span>
                        ) : ical.last_synced_at ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                            <CheckCircle className="w-2.5 h-2.5" /> Synced
                          </span>
                        ) : (
                          <span className="text-[10px] font-medium text-ink-3 bg-bg-2 px-1.5 py-0.5 rounded">Never synced</span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-ink-3 break-all">{ical.url}</div>
                      {ical.last_sync_error && (
                        <div className="mt-1 text-[11px] text-red-700 bg-red-50 rounded p-1.5 font-mono break-all">
                          {String(ical.last_sync_error).slice(0, 200)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => syncFeed(ical.id)}
                        disabled={syncingFeed === ical.id}
                        data-testid="existing-feed-sync"
                        className="text-ink-3 hover:text-blue-600 p-1 disabled:opacity-50"
                        aria-label="Sync this feed"
                        title="Sync just this feed">
                        <RefreshCw className={`w-4 h-4 ${syncingFeed === ical.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button onClick={() => removeFeed(ical.id)}
                        data-testid="existing-feed-remove"
                        className="text-ink-3 hover:text-red-500 p-1"
                        aria-label="Remove feed">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Bulk add */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-3 mb-2">Add feeds</h2>
          <p className="text-xs text-ink-3 mb-2">Paste one URL per line. Source is auto-detected from the domain (Airbnb, VRBO, Booking.com).</p>
          <textarea
            value={paste}
            onChange={e => setPaste(e.target.value)}
            placeholder={'https://www.airbnb.com/calendar/ical/12345.ics?s=...\nhttps://www.vrbo.com/icalendar/abc.ics?nonTentative'}
            rows={4}
            data-testid="bulk-paste"
            className={INPUT + ' font-mono text-[12px] resize-y min-h-[96px]'} />

          {/* Defaults disclosure */}
          <button type="button"
            onClick={() => setShowDefaults(d => !d)}
            className="mt-2 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink-2">
            <ChevronDown className={`w-3 h-3 transition-transform ${showDefaults ? 'rotate-180' : ''}`} />
            Default checkout time / duration (optional)
          </button>
          {showDefaults && (
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <label className="block text-[11px] text-ink-3 mb-1">Checkout time</label>
                <input type="time" value={defaults.checkout_time}
                  onChange={e => setDefaults(d => ({ ...d, checkout_time: e.target.value }))}
                  className={INPUT} />
              </div>
              <div>
                <label className="block text-[11px] text-ink-3 mb-1">Duration (hours)</label>
                <input type="number" step="0.5" min="0.5" value={defaults.duration_hours}
                  onChange={e => setDefaults(d => ({ ...d, duration_hours: e.target.value }))}
                  placeholder={String(property.default_duration_hours || 3)}
                  className={INPUT} />
              </div>
            </div>
          )}

          {/* Detected rows preview */}
          {parsedRows.length > 0 && (
            <div className="mt-3 space-y-2">
              {parsedRows.map(row => (
                <div key={row.idx}
                  className={`bg-panel border rounded-lg p-2.5 ${row.duplicate ? 'border-hairline opacity-60' : !row.valid ? 'border-red-200' : 'border-hairline'}`}
                  data-testid="parsed-feed-row">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <select value={row.source}
                      onChange={e => setPerRowSource(s => ({ ...s, [row.idx]: e.target.value }))}
                      className="text-[11px] bg-panel border border-hairline rounded px-2 py-1 focus:outline-none">
                      {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    {row.duplicate && (
                      <span className="text-[10px] font-semibold text-ink-3 bg-bg-2 px-1.5 py-0.5 rounded">Already on this property</span>
                    )}
                    {!row.valid && (
                      <span className="text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">Not a valid URL</span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-ink-3 break-all">{row.url || row.raw}</div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button onClick={addAll}
              disabled={adding || validRows.length === 0}
              data-testid="bulk-add"
              className="flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-bg-2 disabled:text-ink-3 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex-1 sm:flex-none">
              <LinkIcon className="w-3.5 h-3.5" />
              {adding ? 'Adding…' : `Add ${validRows.length || ''} feed${validRows.length === 1 ? '' : 's'}`.trim()}
            </button>
            {validRows.length > 0 && (
              <span className="text-xs text-ink-3">
                {validRows.length} ready · {parsedRows.length - validRows.length} skipped
              </span>
            )}
          </div>

          {addResults && (
            <ul className="mt-3 space-y-1.5">
              {addResults.map((r, i) => (
                <li key={i} className={`flex items-start gap-2 text-xs rounded-md px-2.5 py-1.5 border ${r.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                  {r.ok ? <CheckCircle className="w-3 h-3 mt-0.5 shrink-0" /> : <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />}
                  <span className="font-mono break-all flex-1">{r.url}</span>
                  {!r.ok && <span className="shrink-0">{r.error}</span>}
                </li>
              ))}
              {addResults.some(r => r.ok) && (
                <li className="pt-1">
                  <button onClick={sync}
                    disabled={syncing}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                    {syncing ? 'Syncing…' : 'Sync now to create turnover jobs →'}
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>

        <p className="text-[11px] text-ink-3">
          Looking for this property? <Link to={`/properties/${propertyId}`} className="text-blue-600">Open property details</Link>
        </p>
      </div>
    </div>
  )
}
