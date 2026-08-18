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
 *
 * Presentation: a bottom sheet on phones (thumb-reachable, one-tap targets)
 * and a centered card on desktop. "This visit only" leads as the primary,
 * most-common choice. API (mode / onChoose / onCancel / busy) is unchanged.
 */
import { Repeat, Calendar, CalendarRange, CalendarDays, BellOff } from 'lucide-react'
import Button from '../ui/Button'

const SCOPES = [
  {
    value: 'this',
    label: 'This visit only',
    detail: 'Only this occurrence changes. The rest of the series is unaffected.',
    icon: Calendar,
    primary: true,
  },
  {
    value: 'future',
    label: 'This and all future visits',
    detail: 'This visit and every one after it switch to the new day, time, and crew.',
    icon: CalendarRange,
  },
  {
    value: 'all',
    label: 'All visits in the series',
    detail: 'Every visit already on the calendar, past and future, updates to match.',
    icon: CalendarDays,
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
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/50" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full sm:max-w-sm bg-panel border border-hairline rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] max-h-[90dvh] overflow-y-auto overscroll-contain">
        {/* Grab handle — reads as a bottom sheet on mobile; hidden on desktop. */}
        <div className="sm:hidden mx-auto mb-3 h-1 w-10 rounded-full bg-hairline" />

        <div className="flex items-center gap-2 mb-1">
          <Repeat className="w-4 h-4 text-blue-500" />
          <h3 className="text-base font-bold text-ink">{title}</h3>
        </div>
        <p className="text-sm text-ink-2 mb-4">{intro}</p>

        <div className="space-y-2 mb-4">
          {scopes.map(s => {
            const Icon = s.icon
            return (
              <button
                key={s.value}
                type="button"
                disabled={busy}
                onClick={() => onChoose(s.value)}
                className={`w-full text-left px-3.5 py-3 rounded-xl border flex items-start gap-3 transition-colors disabled:opacity-50 active:scale-[0.99] ${
                  s.primary
                    ? 'border-indigo-400 bg-panel hover:bg-bg-2'
                    : 'border-hairline hover:border-indigo-400 hover:bg-bg-2'
                }`}
              >
                <span className={`mt-0.5 w-8 h-8 shrink-0 rounded-lg flex items-center justify-center bg-bg-2 ${
                  s.primary ? 'text-indigo-600 dark:text-indigo-300' : 'text-ink-3'
                }`}>
                  <Icon className="w-4 h-4" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{s.label}</span>
                    {s.primary && mode !== 'delete' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
                        Most common
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-ink-3 mt-0.5">{s.detail}</span>
                </span>
              </button>
            )
          })}
        </div>

        {/* Ties the reschedule flow to the "don't ping them every time we move
            it" behavior: moves are silent by default (Settings → Automation). */}
        {mode !== 'delete' && (
          <div className="flex items-start gap-2 mb-4 text-xs text-ink-3">
            <BellOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Moving a visit won’t email the customer unless you’ve turned that on in Settings.</span>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            Never mind
          </Button>
        </div>
      </div>
    </div>
  )
}
