import { AlertTriangle, Calendar, Clock, Home, Link, RefreshCw, Users } from 'lucide-react'
import { ICAL_SOURCES, PROPERTY_TYPE_CONFIG } from './constants'
import { IcalFeedRow } from './IcalFeedRow'

const propType = (p) => (p?.property_type || '').toLowerCase()

/** One property card in the main list. Header row (checkbox, type icon,
 *  name + badge, client, address, type-specific metadata chips, action
 *  buttons) collapses/expands to reveal iCal feed management (for STR) +
 *  notes.
 *
 *  Fully props-in. Parent still owns the expansion state, selection Set,
 *  iCal form draft, and every API call — this row just forwards user
 *  intent up. */
export function PropertyRow({
  p,
  clients,
  clientName,
  selectedIds, toggleSelect,
  expandedPropId, setExpandedPropId,
  syncing, syncOne,
  navigate,
  openEdit,
  deactivateOne,
  icalForm, setIcalForm,
  showIcalForm, setShowIcalForm,
  addIcal, removeIcal,
}) {
  const pType = propType(p)
  const Config = PROPERTY_TYPE_CONFIG[pType]
  const Icon = Config?.icon || Home

  return (
    <div className={`bg-panel border rounded-xl ${selectedIds.has(p.id) ? 'border-blue-400' : 'border-hairline'}`}>
      {/* Property header */}
      <div className="px-4 py-2.5 cursor-pointer hover:bg-bg-2/60 transition-colors" onClick={() => setExpandedPropId(expandedPropId === p.id ? null : p.id)}>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div className="flex items-start gap-4 flex-1 min-w-0">
            <input
              type="checkbox"
              checked={selectedIds.has(p.id)}
              onChange={(e) => toggleSelect(p.id, e)}
              onClick={(e) => e.stopPropagation()}
              className="w-4 h-4 rounded border-hairline cursor-pointer mt-3 shrink-0"
              data-testid="property-row-checkbox"
              aria-label={`Select ${p.name}`}
            />
            <div className={`w-10 h-10 rounded-xl ${Config?.badge} flex items-center justify-center shrink-0 bg-opacity-20`}>
              <Icon className={`w-5 h-5 ${Config?.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <div className="font-semibold text-ink">{p.name}</div>
                <span className={`text-xs px-2 py-0.5 rounded ${Config?.badge}`}>{Config?.label}</span>
              </div>
              <div className="text-sm text-ink-2 flex items-center gap-2 mt-1">
                {!clients.find(c => c.id === p.client_id) && (
                  <AlertTriangle className="w-3 h-3 text-red-400" title="Client not found" />
                )}
                {clientName(p.client_id)}
              </div>
              <div className="text-sm text-ink-3 mt-0.5">{p.address}{p.city ? `, ${p.city}` : ''}</div>

              {/* Type-specific metadata */}
              <div className="flex items-center gap-4 mt-2 flex-wrap">
                {pType === 'str' && (
                  <>
                    <span className="flex items-center gap-1 text-xs text-ink-3">
                      <Clock className="w-3 h-3" />{p.default_duration_hours}h turnover
                    </span>
                    {p.house_code && (
                      <span className="text-xs bg-blue-500/10 text-blue-600 px-2 py-0.5 rounded">
                        Code: {p.house_code}
                      </span>
                    )}
                    {p.check_in_time && (
                      <span className="text-xs text-ink-3">
                        {p.check_in_time} → {p.check_out_time}
                      </span>
                    )}
                    {(p.icals?.length || 0) > 0 && (
                      <span className="flex items-center gap-1 text-xs text-green-600">
                        <Link className="w-3 h-3" />{p.icals.length} feed{p.icals.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {/* Rolled-up feed health (Tier 3 roadmap): a dead feed
                        used to only surface via an on-demand sweep or a
                        per-feed pill you had to expand the card to see. */}
                    {p.ical_health && p.ical_health !== 'no_feed' && (
                      <span
                        className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2"
                        title={p.ical_health === 'healthy'
                          ? 'A feed synced cleanly within the last 24h'
                          : "No feed has synced cleanly in 24h+ — check it"}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${p.ical_health === 'healthy' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                        {p.ical_health === 'healthy' ? 'Feed healthy' : 'Feed stale'}
                      </span>
                    )}
                    {p.ical_health === 'no_feed' && (
                      <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2"
                        title="STR property with no active calendar feed configured">
                        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />No feed
                      </span>
                    )}
                    {/* A missed turnover means a guest walks into a dirty
                        rental — a broken feed state gets its fix one click
                        away, not buried behind expand-the-card. */}
                    {(p.ical_health === 'no_feed' || p.ical_health === 'stale') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); navigate(`/properties/${p.id}/icals`) }}
                        className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 hover:underline"
                      >
                        {p.ical_health === 'no_feed' ? 'Add feed →' : 'Check feed →'}
                      </button>
                    )}
                    {typeof p.turnovers_next_30d === 'number' && (
                      <span className="flex items-center gap-1 text-xs text-ink-3" title="Turnovers scheduled in the next 30 days">
                        <Calendar className="w-3 h-3" />{p.turnovers_next_30d} next 30d
                      </span>
                    )}
                  </>
                )}
                {(pType === 'residential' || pType === 'commercial') && (
                  <>
                    {p.default_duration_hours && (
                      <span className="flex items-center gap-1 text-xs text-ink-3">
                        <Clock className="w-3 h-3" />{p.default_duration_hours}h standard
                      </span>
                    )}
                    {p.default_crew_size && (
                      <span className="flex items-center gap-1 text-xs text-ink-3">
                        <Users className="w-3 h-3" />{p.default_crew_size} crew
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:ml-2 shrink-0">
            {pType === 'str' && (p.icals?.length || 0) > 0 && (
              <button onClick={(e) => { e.stopPropagation(); syncOne(p.id) }} disabled={syncing === p.id}
                className="flex items-center gap-1.5 bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border border-orange-600/30 px-3 py-1.5 rounded-lg text-xs transition-colors">
                <RefreshCw className={`w-3.5 h-3.5 ${syncing === p.id ? 'animate-spin' : ''}`} />
                {syncing === p.id ? 'Syncing...' : 'Sync'}
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); navigate(`/properties/${p.id}`) }}
              className="text-xs text-blue-600 dark:text-blue-300 hover:text-blue-900 bg-blue-100 dark:bg-blue-500/15 hover:bg-blue-200 dark:hover:bg-blue-500/25 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              Jobs
            </button>
            <button onClick={(e) => { e.stopPropagation(); openEdit(p) }}
              className="text-xs text-ink-3 hover:text-ink bg-bg-2 hover:bg-bg-2 px-3 py-1.5 rounded-lg transition-colors">
              Edit
            </button>
            {/* Honest label: the backend's DELETE is a soft deactivate
                (active=false) — jobs and history stay, so no "Delete" here. */}
            <button onClick={(e) => { e.stopPropagation(); deactivateOne(p) }}
              title={`Deactivate ${p.name} — hides it from lists, keeps its jobs and history`}
              className="text-xs text-red-600 hover:text-red-700 border border-hairline hover:border-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 px-3 py-1.5 rounded-lg transition-colors">
              Deactivate
            </button>
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expandedPropId === p.id && (
        <div className="border-t border-hairline p-5 space-y-4 bg-bg">
          {/* STR: iCal URLs */}
          {pType === 'str' && (
            <div data-testid="ical-feeds-section">
              <div className="text-sm font-semibold text-ink-2 mb-2">Calendar Feeds</div>
              {(p.icals || []).map(ical => (
                <IcalFeedRow
                  key={ical.id}
                  ical={ical}
                  onRemove={() => removeIcal(p.id, ical.id)}
                />
              ))}

              {showIcalForm === p.id ? (
                <div className="bg-panel border border-hairline rounded-lg p-3 space-y-2">
                  <input value={icalForm.url} onChange={e => setIcalForm(f => ({ ...f, url: e.target.value }))}
                    placeholder="https://www.airbnb.com/calendar/ical/..."
                    className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none" />
                  <select value={icalForm.source} onChange={e => setIcalForm(f => ({ ...f, source: e.target.value }))}
                    className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none">
                    <option value="">Source (Airbnb / VRBO / …)</option>
                    {ICAL_SOURCES.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-ink-3">
                    Checkout time, duration, and access code come from this property's STR settings.
                  </p>

                  <div className="flex gap-2 pt-2">
                    <button onClick={() => addIcal(p.id)}
                      className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white px-2 py-1.5 rounded text-xs font-medium">
                      Add Calendar
                    </button>
                    <button onClick={() => setShowIcalForm(null)}
                      className="flex-1 bg-bg-2 hover:bg-bg-2 text-ink-2 px-2 py-1.5 rounded text-xs">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button onClick={() => setShowIcalForm(p.id)}
                    className="w-full text-xs text-blue-600 dark:text-blue-300 hover:text-blue-700 border border-indigo-600/20 bg-blue-50/50 dark:bg-blue-500/10 hover:bg-blue-50 dark:hover:bg-blue-500/20 px-3 py-2 rounded-lg transition-colors">
                    + Add Calendar URL
                  </button>
                  <button onClick={() => navigate(`/properties/${p.id}/icals`)}
                    className="w-full text-[11px] text-ink-3 hover:text-ink-2 mt-1.5">
                    Or paste multiple URLs at once →
                  </button>
                </>
              )}
            </div>
          )}

          {p.notes && (
            <div>
              <div className="text-xs text-ink-3 font-semibold mb-1">Notes</div>
              <div className="text-sm text-ink-2 bg-panel rounded p-2 border border-hairline">{p.notes}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
