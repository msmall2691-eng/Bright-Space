import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { SERIES_STATE_LABEL, groupDuplicateSeries, isLiveSeries, seriesState } from '../../utils/recurringDuplicates'
import { computeUpcoming, fmtDate, fmtTime, ruleSummary } from './helpers'
import { Pause } from 'lucide-react'
import { SEV_DOT } from '../board/tokens'

export default function SeriesRow({ s, clientName, onOpen, isDuplicate }) {
  const next = useMemo(() => {
    const up = computeUpcoming(s, [], 1)
    return up[0]?.date
  }, [s])
  const hasTime = !!s.start_time
  // Active-but-past-its-end-date (how split retires a predecessor: only
  // series_end_date is set, `active` stays true) reads as a quiet "Ended",
  // not as a live series.
  const live = isLiveSeries(s)
  return (
    <li>
      <button
        onClick={() => onOpen(s.id)}
        className="w-full text-left bg-panel border border-hairline rounded-lg px-4 py-2.5 hover:bg-bg-2/60 transition"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="text-base font-semibold text-ink">{s.title || 'Untitled'}</h3>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <span className={`h-1.5 w-1.5 rounded-full ${live ? '${SEV_DOT.good}' : 'bg-ink-3'}`} />
                {SERIES_STATE_LABEL[seriesState(s)]}
              </span>
              {isDuplicate && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2"
                  title="Another live series for this client has the same property, cadence, and time on an overlapping day — likely a duplicate. Open both and pause or cancel one.">
                  <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT.watch}`} />
                  Possible duplicate
                </span>
              )}
            </div>
            <p className="text-[13px] text-ink-2 truncate">
              {s.client_id ? (
                <Link to={`/clients/${s.client_id}`} onClick={e => e.stopPropagation()}
                  className="no-underline hover:text-link hover:underline">
                  {clientName}
                </Link>
              ) : clientName}
              {' · '}{s.address}
            </p>
            <p className="text-[12px] text-ink-3 mt-1">
              {ruleSummary(s)}
              {hasTime
                ? <> · {fmtTime(s.start_time)}–{fmtTime(s.end_time)}</>
                : <> · <span className="text-amber-600 font-medium">no time set</span></>}
              {next && live && <> · Next {fmtDate(next)}</>}
              <> · {s.upcoming_job_count || 0} upcoming</>
            </p>
          </div>
          <span className="text-xs text-ink-3 self-center">Manage →</span>
        </div>
      </button>
    </li>
  )
}

// Duplicate grouping (same client + property + cadence + time, overlapping
// days, LIVE series only) lives in utils/recurringDuplicates.js —
// groupDuplicateSeries is THE single definition, shared by the list pills,
// the banner count, and the review panel below, and aligned with the
// backend's pre-create guard (services/recurring_guards.py).

// ─── Duplicate review panel ──────────────────────────────────────────────
// Groups "Possible duplicate" series side by side so the owner can pick the
// keeper and pause/cancel the others one confirmed action at a time. Drives
// ONLY the existing Manage endpoints — PATCH {active:false} (pause, same as
// the detail page's Pause button) and DELETE (soft-cancel: sets active=false;
// already-scheduled visits stay on the calendar, past visits untouched).
// Nothing is automatic: every action goes through the app's confirm dialog,
// and nothing is ever hard-deleted (scheduling-invariants R7).
