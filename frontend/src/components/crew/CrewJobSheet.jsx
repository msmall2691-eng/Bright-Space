/**
 * Crew job detail sheet — tap any job row/chip in the crew app and get the
 * SAME full card My Day renders (address → maps, door code, notes, WiFi,
 * house notes, checklist), fetched from GET /api/crew/jobs/{id}.
 *
 * That endpoint is assigned-cleaner-only (404 for anyone else), so this sheet
 * can never leak another cleaner's access details — it is the ONLY way crew
 * surfaces open a job (never the office /api/jobs/{id}/details).
 */
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { get } from '../../api'
import { Skeleton } from '../ui'
import JobCard from './JobCard'
import { ErrorNote } from './primitives'

function dayLine(job) {
  if (!job?.scheduled_date) return ''
  return new Date(`${job.scheduled_date}T12:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

export default function CrewJobSheet({ jobId, onClose }) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setJob(null); setError(null)
    get(`/api/crew/jobs/${jobId}`)
      .then(d => { if (!cancelled) setJob(d) })
      .catch(e => { if (!cancelled) setError(e.detail || e.message || 'Could not load') })
    return () => { cancelled = true }
  }, [jobId])

  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
      onClick={onClose}>
      <div className="w-full max-w-sm max-h-[85dvh] overflow-y-auto space-y-2"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 bg-panel rounded-xl border border-hairline px-4 py-2.5">
          <div className="text-[13px] font-bold text-ink truncate">
            {job ? dayLine(job) || 'Job details' : 'Loading…'}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 grid place-items-center w-9 h-9 -mr-1.5 rounded-lg bg-bg-2 text-ink-3 active:scale-95 transition-transform">
            <X className="w-4 h-4" />
          </button>
        </div>
        <ErrorNote>{error}</ErrorNote>
        {!job && !error && <Skeleton className="h-40 w-full rounded-xl" />}
        {job && <JobCard job={job} />}
      </div>
    </div>
  )
}
