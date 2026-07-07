/**
 * Content-area skeleton used while the initial /api/schedule/week fetch is
 * in flight. The toolbar + health strip stay live around this (audit §12 —
 * previously the whole page blanked to a "Loading schedule..." text) so the
 * user still sees which view/date/filters they're on.
 *
 * Three shapes match the three views so the skeleton doesn't "morph" as
 * soon as data lands: agenda = a few tall cards; week = 7 narrow columns
 * with a few block placeholders; month = a 6×7 grid of dim cells. Uses
 * Tailwind's animate-pulse — cheap, no motion library.
 */
export default function ScheduleSkeleton({ viewMode = 'month' }) {
  if (viewMode === 'agenda') {
    return (
      <div className="flex-1 overflow-hidden p-3 sm:p-4" data-testid="schedule-skeleton-agenda">
        <div className="max-w-2xl mx-auto space-y-2 sm:space-y-3">
          <div className="h-4 w-32 rounded bg-bg-2 animate-pulse mb-2" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-3 sm:p-4 rounded-xl bg-panel border border-hairline animate-pulse space-y-2">
              <div className="h-3 w-24 rounded bg-bg-2" />
              <div className="h-4 w-3/4 rounded bg-bg-2" />
              <div className="h-3 w-1/2 rounded bg-bg-2" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (viewMode === 'week') {
    return (
      <div className="flex-1 overflow-hidden p-2" data-testid="schedule-skeleton-week">
        <div className="grid h-full gap-px bg-bg-2 rounded-xl overflow-hidden border border-hairline"
             style={{ gridTemplateColumns: `56px repeat(7, minmax(0, 1fr))` }}>
          <div className="bg-panel/40" />
          {Array.from({ length: 7 }).map((_, col) => (
            <div key={col} className="bg-panel p-1 space-y-1 animate-pulse">
              <div className="h-3 w-8 rounded bg-bg-2 mx-auto" />
              <div className="h-5 rounded bg-bg-2 mt-3" />
              {col % 2 === 0 && <div className="h-8 rounded bg-bg-2 mt-8" />}
              {col % 3 === 0 && <div className="h-12 rounded bg-bg-2 mt-1" />}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // month
  return (
    <div className="flex-1 overflow-hidden p-2" data-testid="schedule-skeleton-month">
      <div className="grid grid-cols-7 gap-1 h-full">
        {Array.from({ length: 42 }).map((_, i) => {
          const busy = i % 5 === 0
          return (
            <div key={i} className="rounded-md bg-panel border border-hairline p-1 space-y-1 animate-pulse">
              <div className="w-5 h-5 rounded-full bg-bg-2" />
              <div className="h-2 rounded bg-bg-2" />
              {busy && <div className="h-2 rounded bg-bg-2" />}
              {busy && <div className="h-2 w-2/3 rounded bg-bg-2" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
