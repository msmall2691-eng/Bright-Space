import { AlertTriangle, CheckCircle, Clock, Trash2 } from 'lucide-react'
import { ICAL_SOURCES } from './constants'
import { isStaleSync, relTimeAgo } from './utils'

/** One row per iCal feed on a STR property. Shows the URL (truncated),
 *  source label, and a sync-status pill so the operator can see at a
 *  glance "is this feed actually working?" without checking server logs.
 *  The per-feed Sync Now button currently triggers a property-level sync
 *  (the backend syncs all feeds on a property together, by design). */
export function IcalFeedRow({ ical, onRemove }) {
  const sourceLabel = ICAL_SOURCES.find(s => s.value === (ical.source || '').toLowerCase())?.label
    || ical.source
    || 'Custom'
  const status = ical.last_sync_status
  const lastAt = relTimeAgo(ical.last_synced_at)

  // Status precedence: failed > ok-on-timestamp > never synced.
  // Treat any feed with last_synced_at set as "Synced" even when
  // last_sync_status is null — historic rows from before #93's
  // sync_property update lacked a status string, and rendering them
  // as "Never synced" would defeat the whole observability feature
  // (Codex P1).
  let statusPill
  if (status === 'failed' || status === 'retrying') {
    statusPill = (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300" title={ical.last_sync_error || ''}>
        <AlertTriangle className="w-3 h-3" /> Failed {lastAt || ''}
      </span>
    )
  } else if (status === 'ok' || ical.last_synced_at) {
    // A "Synced" pill on a feed that last synced days ago is a lie by
    // omission — auto-sync runs every 15 min, so >24h without a clean sync
    // means the feed is stale (same cutoff as the property-level rollup).
    const stale = isStaleSync(ical.last_synced_at)
    statusPill = stale ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300"
        title="No clean sync in 24h+ — check this feed">
        <AlertTriangle className="w-3 h-3" /> Stale · synced {lastAt || '—'}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
        <CheckCircle className="w-3 h-3" /> Synced {lastAt || ''}
      </span>
    )
  } else {
    statusPill = (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-bg-2 text-ink-2">
        <Clock className="w-3 h-3" /> Never synced
      </span>
    )
  }

  return (
    <div className="bg-panel border border-hairline rounded-lg p-2.5 mb-2">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-semibold text-ink-2 uppercase tracking-wide">{sourceLabel}</span>
            {!ical.active && (
              <span className="text-[10px] font-semibold text-ink-3 bg-bg-2 px-1.5 py-0.5 rounded">paused</span>
            )}
            {statusPill}
            {/* Count from the last known-good sync — "what did this feed
                actually produce?" without opening server logs. */}
            {ical.last_events_seen != null && (
              <span className="text-[11px] text-ink-3">{ical.last_events_seen} event{ical.last_events_seen === 1 ? '' : 's'}</span>
            )}
          </div>
          <div className="text-xs text-ink-3 truncate font-mono" title={ical.url}>{ical.url}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onRemove}
            className="text-red-400 hover:text-red-600 p-2 -m-1 rounded-lg"
            title="Remove feed"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {status === 'failed' && ical.last_sync_error && (
        <div className="text-[11px] text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 rounded p-1.5 mb-1.5 font-mono break-all">
          {ical.last_sync_error.slice(0, 200)}
        </div>
      )}
      {(ical.checkout_time || ical.house_code || ical.instructions) && (
        <div className="text-xs text-ink-3 bg-bg rounded p-1.5 space-y-0.5">
          {ical.checkout_time && <div>Checkout: {ical.checkout_time}</div>}
          {ical.house_code && <div>Code: {ical.house_code}</div>}
          {ical.instructions && <div className="text-ink-2">{ical.instructions}</div>}
        </div>
      )}
    </div>
  )
}
