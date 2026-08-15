/**
 * Left column of the dispatch board — every job today that's still
 * waiting on a crew, sorted by start time. Empty state reads as a win
 * ("Every job today has a crew — nice.") rather than a hollow shell.
 *
 * Each card is draggable — drop it on a crew card in CrewUtilization to
 * assign that visit (see DispatchBoard's commitAssign). Cards also carry a
 * quiet "Open to crew" action (crew app Phase 3: open_for_claims) so the
 * office can put a job up for grabs right where the gap is visible.
 */
import { CheckCircle2 } from 'lucide-react'
import { PROPERTY_TYPE_CONFIG } from './constants'

export default function UnassignedQueue({
  visits, jobs, properties, clients, onOpen, onDragStartVisit, onDragEndVisit,
  onOpenToCrew,
}) {
  return (
    <div className="bg-bg-2 border border-hairline rounded-2xl p-3 flex flex-col min-w-0">
      <div className="flex items-center justify-between mb-3 px-1">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono tracking-widest uppercase text-ink-3">
          {/* Amber dot — the same needs-a-cleaner cue the month chips and day
              cards use, so the queue reads as "these are the amber ones". */}
          {visits.length > 0 && (
            <span className="w-[7px] h-[7px] rounded-full bg-amber-400 ring-2 ring-amber-200/70 dark:ring-amber-500/25 shrink-0" aria-hidden="true" />
          )}
          Unassigned queue
        </span>
        <span className="text-[11px] font-mono tabular-nums text-ink">
          {visits.length}
        </span>
      </div>

      {visits.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
          <CheckCircle2 className="w-6 h-6 text-emerald-500 mb-2" />
          <p className="text-[13px] text-ink">Every job today has a crew.</p>
          <p className="text-[11.5px] text-ink-3 mt-0.5">Nice — nothing waiting.</p>
        </div>
      ) : (
        <ul className="space-y-2 overflow-y-auto flex-1">
          {visits.map(v => {
            const job = jobs[v.job_id]
            const prop = properties[job?.property_id]
            const client = clients[job?.client_id]
            const type = prop?.property_type || job?.job_type || 'residential'
            const typeCfg = PROPERTY_TYPE_CONFIG[type] || PROPERTY_TYPE_CONFIG.residential
            const start = (v.start_time || '').slice(0, 5)
            const end = (v.end_time || '').slice(0, 5)
            const isOpen = !!(v.open_for_claims || job?.open_for_claims)
            return (
              <li key={v.id}>
                <button
                  type="button"
                  draggable={!!onDragStartVisit}
                  onDragStart={onDragStartVisit ? (e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    try { e.dataTransfer.setData('text/plain', String(v.id)) } catch { /* ignore */ }
                    onDragStartVisit(v)
                  } : undefined}
                  onDragEnd={onDragEndVisit}
                  onClick={() => onOpen?.(v, job, prop)}
                  className={`w-full text-left bg-panel border border-hairline rounded-xl px-3 py-2.5 hover:border-amber-300 hover:shadow-sm transition-all ${onDragStartVisit ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  style={{ borderLeft: '3px solid #F59E0B' }}
                >
                  <div className="text-[11px] font-mono tabular-nums text-ink-3">
                    {start}{end && ` – ${end}`}
                  </div>
                  {/* Client name first — same truncation priority as the month
                      chips, and the same label the timeline block shows, so a
                      drag between columns tracks one name. */}
                  <div className="text-[13.5px] font-semibold text-ink tracking-tight mt-0.5">
                    {client?.name || job?.title || `Visit ${v.id}`}
                  </div>
                  {prop?.address && (
                    <div className="text-[11.5px] text-ink-3 mt-0.5 truncate">
                      {prop.address}
                    </div>
                  )}
                  <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
                    {/* Dot+word type tag — quiet, no tinted capsule. */}
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-3">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${typeCfg.dot}`} aria-hidden="true" />
                      {typeCfg.label}
                    </span>
                    {isOpen ? (
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-ink-3"
                        title="Crew can claim this job from their phone">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" aria-hidden="true" />
                        Open to crew
                      </span>
                    ) : onOpenToCrew ? (
                      /* Plain span, not <button> — the whole card is already a
                         <button>, and HTML forbids nesting interactive
                         elements. stopPropagation keeps it from opening the
                         drawer. */
                      <span
                        onClick={e => { e.stopPropagation(); onOpenToCrew([v]) }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onOpenToCrew([v]) } }}
                        className="inline-flex items-center px-2 py-0.5 rounded-md border border-hairline-2 bg-panel text-[10.5px] font-medium text-ink-2 hover:bg-bg-2 cursor-pointer transition-colors"
                        title="Let cleaners claim this job from their phone"
                        role="button"
                        tabIndex={0}
                      >
                        Open to crew
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
