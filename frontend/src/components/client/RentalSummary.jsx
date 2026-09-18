import { ExternalLink } from 'lucide-react'

/**
 * RentalSummary — the read-only, at-a-glance rental facts for an STR property,
 * shown on the property card so the operator sees them WITHOUT opening Edit.
 *
 * Before this, everything that makes a rental a rental — check-in/out times,
 * turnover length, price, guest count, listing link, and iCal sync health —
 * lived only inside the Property edit form (gated behind property_type==='str'),
 * so an STR client's page read like a residential one and you had to click Edit
 * to learn anything. This surfaces it, quietly (dot+word, plain ink values, no
 * bubbles), and renders nothing for a non-STR property or when there's nothing
 * to show.
 */
function fmtTime(hhmm) {
  // "14:00" -> "2:00 PM". Leaves anything it can't parse as-is (the request may
  // have carried a raw phrase we preserved rather than a clean time).
  if (!hhmm || typeof hhmm !== 'string') return hhmm || null
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return hhmm
  let h = Number(m[1])
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m[2]} ${ampm}`
}

function FeedRow({ feed }) {
  const failed = feed.last_sync_status === 'failed'
  const synced = !failed && feed.last_synced_at
  const dot = failed ? 'bg-red-500' : synced ? 'bg-emerald-500' : 'bg-ink-3/40'
  return (
    <div className="flex items-center gap-1.5 text-[11px]" data-testid="rental-feed-row">
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
      <span className="text-ink-2">{feed.source || 'Calendar feed'}</span>
      <span className="text-ink-3">
        {failed
          ? 'sync failed'
          : synced
            ? `synced ${new Date(feed.last_synced_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
            : 'never synced'}
      </span>
    </div>
  )
}

export default function RentalSummary({ property: p }) {
  if (!p || (p.property_type || '').toLowerCase() !== 'str') return null
  const cf = p.custom_fields || {}
  const feeds = p.icals || []

  const facts = [
    p.check_out_time && ['Check-out', fmtTime(p.check_out_time)],
    p.check_in_time && ['Check-in', fmtTime(p.check_in_time)],
    p.default_duration_hours && ['Turnover', `${p.default_duration_hours}h`],
    p.default_price != null && p.default_price !== '' && ['Price / turnover', `$${Number(p.default_price).toFixed(2)}`],
    cf.guests && ['Sleeps', String(cf.guests)],
    cf.turnover_day && ['Turnover day', String(cf.turnover_day)],
    // Forward-compatible: renders once a linen plan is stored on the property.
    cf.linen && ['Linens', String(cf.linen)],
  ].filter(Boolean)

  if (!facts.length && !feeds.length && !cf.listing_url) return null

  return (
    <div className="mt-3 pt-3 border-t border-hairline" data-testid="rental-summary">
      {facts.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] uppercase tracking-wide text-ink-3">{label}</dt>
              <dd className="text-xs text-ink-2 mt-0.5">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {cf.listing_url && (
        <a href={cf.listing_url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 mt-2.5 text-xs text-ink hover:text-indigo-600 no-underline">
          View listing <ExternalLink className="w-3 h-3" />
        </a>
      )}

      {feeds.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">Calendar feeds</div>
          <div className="space-y-1">
            {feeds.map(f => <FeedRow key={f.id ?? f.url} feed={f} />)}
          </div>
        </div>
      )}
    </div>
  )
}
