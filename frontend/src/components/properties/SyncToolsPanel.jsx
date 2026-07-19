import { CheckCircle, RefreshCw, X } from 'lucide-react'

/** Advanced sync + repair tooling, hidden behind the "Sync tools" toggle
 *  so the everyday "add a link, see turnovers" path stays uncluttered.
 *
 *  Two buttons:
 *   • Sync all feeds — force-pull the latest bookings from every property's
 *     calendar feeds now. Feeds also sync in the background, but this
 *     surface is for the "did that change land?" case.
 *   • Check all turnovers — re-sync every feed and report which turnovers
 *     are missing or not on Google. Populates the SweepResultsPanel. */
export function SyncToolsPanel({ syncAll, syncing, runSweep, sweeping }) {
  return (
    <div className="rounded-xl border border-hairline bg-bg p-4 mb-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={syncAll} disabled={syncing === 'all'}
          title="Pull the latest bookings from every property's calendar feeds now"
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-3.5 py-2 rounded-lg text-sm font-medium transition-colors">
          <RefreshCw className={`w-3.5 h-3.5 ${syncing === 'all' ? 'animate-spin' : ''}`} />
          {syncing === 'all' ? 'Syncing…' : 'Sync all feeds'}
        </button>
        <button onClick={runSweep} disabled={sweeping}
          title="Re-sync every feed and report which turnovers are missing or not on Google"
          className="flex items-center gap-2 bg-panel hover:bg-bg-2 border border-hairline px-3.5 py-2 rounded-lg text-sm transition-colors">
          <CheckCircle className={`w-3.5 h-3.5 ${sweeping ? 'animate-spin' : ''}`} />
          {sweeping ? 'Checking…' : 'Check all turnovers'}
        </button>
        <span className="text-[11px] text-ink-3">Feeds also sync automatically in the background.</span>
      </div>
    </div>
  )
}

/** Turnover health sweep results — populated by `runSweep`. Lists every
 *  property with its scheduled vs. on-Google counts and any missing
 *  dates, with a per-row Rebuild button for the failing ones. Also shows
 *  a headline totals bar (all good / N missing / N not on Google). */
export function SweepResultsPanel({ sweep, onDismiss, rebuildOne, rebuildingId }) {
  return (
    <div className="rounded-xl border border-hairline bg-panel p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-ink">Turnover health</h3>
        <button onClick={onDismiss} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
      </div>
      {sweep.error && <div className="text-sm text-red-600">{sweep.error}</div>}
      {sweep.totals && (
        <div className="text-xs text-ink-3 mb-3">
          {sweep.totals.properties} propert{sweep.totals.properties === 1 ? 'y' : 'ies'} ·
          &nbsp;{sweep.totals.scheduled} turnovers scheduled ·
          &nbsp;{sweep.totals.on_google} on Google
          {(sweep.totals.missing > 0 || sweep.totals.not_on_google > 0)
            ? <span className="text-amber-600 font-medium">&nbsp;· {sweep.totals.missing} missing, {sweep.totals.not_on_google} not on Google</span>
            : <span className="text-emerald-600 font-medium">&nbsp;· all good ✓</span>}
        </div>
      )}
      <div className="space-y-1.5">
        {(sweep.properties || []).map(p => (
          <div key={p.property_id} className="flex items-start justify-between gap-3 text-xs border-b border-hairline/60 last:border-0 py-1.5">
            <div className="min-w-0">
              <span className={`mr-1.5 ${p.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{p.ok ? '✓' : '⚠'}</span>
              <span className="text-ink font-medium">{p.property}</span>
              <span className="text-ink-3"> — {p.scheduled} scheduled, {p.on_google} on Google</span>
              {p.sync_error && <span className="text-red-600"> · {p.sync_error}</span>}
              {p.missing_dates?.length > 0 && (
                <div className="text-amber-600 mt-0.5">Missing turnover: {p.missing_dates.join(', ')}</div>
              )}
              {p.not_on_google > 0 && (
                <div className="text-amber-600 mt-0.5">{p.not_on_google} turnover(s) not on Google — check the connection/calendar.</div>
              )}
            </div>
            {!p.ok && (
              <button onClick={() => rebuildOne(p.property_id)} disabled={rebuildingId !== null}
                title="Force-rebuild this property's turnovers from the feed, then re-check"
                className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0">
                <RefreshCw className={`w-3 h-3 ${rebuildingId === p.property_id ? 'animate-spin' : ''}`} />
                {rebuildingId === p.property_id ? 'Rebuilding…' : 'Rebuild'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
