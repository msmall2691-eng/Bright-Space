/**
 * FeedHealthTile — per-feed turnover (Airbnb/VRBO iCal) health from the
 * Sync Control Center payload (GET /api/jobs/sync-overview → the "airbnb"
 * channel's feeds). A dead feed means a guest checks out and nobody is
 * scheduled to clean — it should be loud here, not discovered on the
 * property page days later.
 *
 * Same vocabulary as /sync and the property pages: failed (red) / never
 * synced (grey) / 24h+ without a clean sync (amber) / fresh (emerald).
 * Words next to the dot, never color alone.
 */
import { CalendarClock } from 'lucide-react'
import { Tile, TileLoading } from './primitives'

const STALE_AFTER_MS = 24 * 60 * 60 * 1000  // mirrors backend _ICAL_STALE_AFTER

const normIso = (iso) => (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)

export function relTime(iso) {
  if (!iso) return 'never'
  const then = new Date(normIso(iso)).getTime()
  if (Number.isNaN(then)) return '—'
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function feedTone(f) {
  if (f.status === 'failed' || f.status === 'retrying') return 'failing'
  if (!f.last_synced_at) return 'never'
  const age = Date.now() - new Date(normIso(f.last_synced_at)).getTime()
  return age > STALE_AFTER_MS ? 'stale' : 'fresh'
}

const DOT = {
  failing: 'bg-red-500',
  stale: 'bg-amber-500',
  never: 'bg-ink-3',
  fresh: 'bg-emerald-500',
}

export function FeedHealthTile({ loading, data, error, navigate }) {
  const airbnb = (data?.channels || []).find(c => c.key === 'airbnb')
  const feeds = airbnb?.feeds || []
  return (
    <Tile icon={CalendarClock} title="Turnover feeds"
      action="Sync Center" onAction={() => navigate('/sync')}>
      {loading ? <TileLoading /> : error ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">Couldn't load feed health.</div>
      ) : feeds.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">
          No rental feeds connected.
        </div>
      ) : (
        <div className="divide-y divide-hairline">
          {feeds.map(f => {
            const tone = feedTone(f)
            const label =
              tone === 'failing' ? (f.last_synced_at ? `failed · last ok ${relTime(f.last_synced_at)}` : 'failed')
              : tone === 'never' ? 'never synced'
              : `${relTime(f.last_synced_at)}${f.last_events_seen != null ? ` · ${f.last_events_seen} events` : ''}`
            return (
              <div key={f.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <a href={`/properties/${f.property_id}`}
                     className="block truncate text-[13px] font-medium text-ink hover:text-indigo-600 no-underline">
                    {f.property}
                  </a>
                  <div className="text-[11px] text-ink-3 capitalize">{f.source}</div>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 shrink-0 text-[11px] tabular-nums ${
                    tone === 'failing' ? 'text-red-600 dark:text-red-300'
                    : tone === 'stale' ? 'text-amber-600 dark:text-amber-300'
                    : 'text-ink-3'}`}
                  title={f.error || ''}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${DOT[tone]}`} aria-hidden="true" />
                  {label}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Tile>
  )
}
