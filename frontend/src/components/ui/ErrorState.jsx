import { AlertTriangle } from 'lucide-react'
import Button from './Button'

/**
 * ErrorState — consistent "this failed, here's how to recover" placeholder.
 *
 * The counterpart to EmptyState: shown when a fetch fails (timeout, network,
 * server error) instead of leaving the screen silently blank. Always offers a
 * Retry so a slow/cold backend or a dropped request is one click from recovery,
 * never an infinite spinner.
 *
 *   <ErrorState onRetry={load} />
 *   <ErrorState title="Couldn't load the schedule"
 *     description={err.message} onRetry={load} />
 *
 * `compact` tightens padding for use inside a Card body.
 */
export default function ErrorState({
  title = 'Something went wrong',
  description = "We couldn't load this. Check your connection and try again.",
  onRetry,
  retryLabel = 'Retry',
  compact = false,
  className = '',
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? 'py-8 px-4' : 'py-14 px-6'
      } ${className}`}
    >
      <div className="w-12 h-12 rounded-2xl bg-bg border border-hairline flex items-center justify-center mb-3">
        <AlertTriangle className="w-5 h-5 text-amber-500" />
      </div>
      {title && <p className="text-sm font-semibold text-ink">{title}</p>}
      {description && (
        <p className="text-[13px] text-ink-3 mt-1 max-w-xs">{description}</p>
      )}
      {onRetry && (
        <div className="mt-4">
          <Button variant="secondary" onClick={onRetry}>{retryLabel}</Button>
        </div>
      )}
    </div>
  )
}
