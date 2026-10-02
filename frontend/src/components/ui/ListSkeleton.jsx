import { Skeleton } from './Skeleton'

/**
 * ListSkeleton — a quiet placeholder for an office list whose first fetch is
 * still in flight. A stack of hairline rows, each with a title + subtitle bar
 * and a small trailing bar, matching the dot+word list rows the app uses.
 *
 * Replaces a bare "Loading…" line so a cold or slow backend reads as calm and
 * shaped, not broken. aria-hidden so a screen reader isn't handed placeholder
 * rows; the live region announces the real data once it lands.
 *
 *   {loading ? <ListSkeleton rows={6} /> : <RealList … />}
 */
export default function ListSkeleton({ rows = 6, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`} data-testid="list-skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-hairline bg-panel px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  )
}
