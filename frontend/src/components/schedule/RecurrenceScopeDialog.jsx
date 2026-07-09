/**
 * Jobber-parity scope prompt for editing/cancelling a recurring job.
 *
 * Shown whenever the admin saves or deletes a Job that has a
 * recurring_schedule_id — the calendar edit path used to PATCH that one Job
 * with no awareness it belonged to a series, so a date change silently
 * orphaned the rule's own copy of that date and regenerated a duplicate
 * next tick. Picking a scope here routes the caller to the mechanism that
 * actually keeps the series consistent (see JobEditModal's save/delete
 * handlers for the routing).
 */
import { Repeat } from 'lucide-react'
import Button from '../ui/Button'

const SCOPES = [
  {
    value: 'this',
    label: 'This visit only',
    detail: 'Only this occurrence changes. The rest of the series is unaffected.',
  },
  {
    value: 'future',
    label: 'This and all future visits',
    detail: 'This visit and every one after it switch to the new day, time, and crew.',
  },
  {
    value: 'all',
    label: 'All visits in the series',
    detail: 'Every visit already on the calendar, past and future, updates to match.',
  },
]

export default function RecurrenceScopeDialog({ mode = 'edit', onChoose, onCancel, busy = false }) {
  const title = mode === 'delete' ? 'Cancel this repeating visit?' : 'This is a repeating visit'
  const intro = mode === 'delete'
    ? 'Choose what this cancellation applies to.'
    : 'Choose what your changes apply to.'
  // Cancelling a whole series doesn't fit this component's job — that's a
  // Recurring-page action (deactivate the schedule). Deleting from the
  // calendar only ever means "this one visit."
  const scopes = mode === 'delete' ? SCOPES.slice(0, 1) : SCOPES

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-sm bg-panel border border-hairline rounded-2xl shadow-2xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Repeat className="w-4 h-4 text-blue-500" />
          <h3 className="text-base font-bold text-ink">{title}</h3>
        </div>
        <p className="text-sm text-ink-2 mb-4">{intro}</p>

        <div className="space-y-2 mb-4">
          {scopes.map(s => (
            <button
              key={s.value}
              type="button"
              disabled={busy}
              onClick={() => onChoose(s.value)}
              className="w-full text-left px-3.5 py-3 rounded-xl border border-hairline hover:border-blue-400 hover:bg-blue-50/40 transition-colors disabled:opacity-50"
            >
              <div className="text-sm font-semibold text-ink">{s.label}</div>
              <div className="text-xs text-ink-3 mt-0.5">{s.detail}</div>
            </button>
          ))}
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            Never mind
          </Button>
        </div>
      </div>
    </div>
  )
}
