/**
 * Left column of the dispatch board — every job today that's still
 * waiting on a crew, sorted by start time. Empty state reads as a win
 * ("Every job today has a crew — nice.") rather than a hollow shell.
 */
import { CheckCircle2 } from 'lucide-react'
import { PROPERTY_TYPE_CONFIG } from './constants'

export default function UnassignedQueue({ visits, jobs, properties, clients, onOpen }) {
  return (
    <div className="bg-bg-2 border border-hairline rounded-2xl p-3 flex flex-col min-w-0">
      <div className="flex items-center justify-between mb-3 px-1">
        <span className="text-[10px] font-mono tracking-widest uppercase text-ink-3">
          Unassigned queue
        </span>
        <span className="text-[11px] font-mono tabular-nums px-2 py-0.5 rounded-full border border-hairline bg-panel text-ink">
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
            return (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => onOpen?.(v, job, prop)}
                  className="w-full text-left bg-panel border border-hairline rounded-xl px-3 py-2.5 hover:border-amber-300 hover:shadow-sm transition-all"
                  style={{ borderLeft: '3px solid #F59E0B' }}
                >
                  <div className="text-[11px] font-mono tabular-nums text-ink-3">
                    {start}{end && ` – ${end}`}
                  </div>
                  <div className="text-[13.5px] font-semibold text-ink tracking-tight mt-0.5">
                    {job?.title || client?.name || `Visit ${v.id}`}
                  </div>
                  {prop?.address && (
                    <div className="text-[11.5px] text-ink-3 mt-0.5 truncate">
                      {prop.address}
                    </div>
                  )}
                  <span className={`inline-block mt-1.5 text-[9.5px] font-mono tracking-widest uppercase px-1.5 py-0.5 rounded ${typeCfg.badge}`}>
                    {typeCfg.label}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
