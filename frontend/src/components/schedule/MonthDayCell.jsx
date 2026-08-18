/**
 * One cell of CalendarView's month grid, split out and wrapped in
 * React.memo so a state change that only affects ONE cell (drag hover,
 * touch-drag position, selecting a day) doesn't re-render all ~35-42 cells
 * every tick. For the memo comparison to actually skip re-renders, the
 * parent must pass referentially-stable props for cells that didn't change:
 * CalendarView memoizes the per-day job/booking/exception lookups (so
 * `dayJobs` etc. keep the same array reference across unrelated renders)
 * and wraps every handler in useCallback with functional state updates (so
 * `onDragOverDay` etc. keep the same function reference during a drag,
 * instead of a fresh closure — and therefore a "changed" prop — on every
 * dragover/touchmove tick).
 */
import { memo } from 'react'
import { Ban, ArrowRight, ArrowLeft, Zap, RotateCw, Plus, ChevronUp } from 'lucide-react'

function MonthDayCell({
  date, dayJobs, dayBookings, daySkips, dayReschedFrom, dayReschedTo,
  isToday, isSelected, isDropTarget, isCheckin, isCheckout,
  isMobile, maxPills, typeConfig, cleanerFor,
  isExpanded, onToggleMore, onQuickAdd,
  onSelectDay, onDragOverDay, onDragLeaveDay, onDropDay,
  onChipDragStart, onChipDragEnd,
  onChipTouchStart, onChipTouchMove, onChipTouchEnd, onChipTouchCancel,
  onJobClick, justDraggedRef,
}) {
  // Desktop: when this day is expanded, show every job (the grid row grows to
  // fit) so a packed day hides nothing; otherwise cap at maxPills with a
  // "+N more" that expands inline. Mobile keeps the compact dots + tap-sheet.
  const shownJobs = isExpanded ? dayJobs : dayJobs.slice(0, maxPills)
  const hiddenCount = dayJobs.length - maxPills
  return (
    <div
      data-day-cell={date}
      onClick={() => onSelectDay(date)}
      onDragOver={e => onDragOverDay(e, date)}
      onDragLeave={onDragLeaveDay}
      onDrop={e => onDropDay(e, date)}
      className={`group/day relative p-1 sm:p-1.5 min-h-[58px] sm:min-h-[110px] cursor-pointer transition-colors ${
        // isDropTarget is a transient drag-hover cue (only while a chip is
        // dragged over this cell) — treated like an interactive hover tint,
        // not a persistent status fill. isSelected/has-bookings used to wash
        // the whole cell in blue/orange; now a ring marks selection and the
        // existing orange booking text (below) carries that cue instead, so
        // no cell ever sits under a permanent tinted background.
        isDropTarget ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset' :
        isSelected ? 'bg-panel ring-1 ring-inset ring-indigo-400 hover:bg-bg' :
        'bg-panel hover:bg-bg'
      }`}
    >
      {/* Day header — date circle + a small density chip on packed days so
          the operator reads volume at a glance without having to fan out
          the chips or open the day panel. Audit §10: month cells hide most
          of a busy day. */}
      <div className="flex items-center justify-between mb-0.5 sm:mb-1">
        <div className={`text-[10px] sm:text-xs font-semibold w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full ${
          isToday ? 'bg-accent text-accent-ink bb-today-badge' :
          isSelected ? 'text-indigo-600' :
          'text-ink-2'
        }`}>
          {parseInt(date.slice(8))}
        </div>
        <div className="flex items-center gap-1">
          {dayJobs.length > maxPills && (
            <span
              className="hidden sm:inline text-[9px] font-semibold text-ink-3 bg-bg-2 border border-hairline rounded-full px-1.5 leading-4"
              title={`${dayJobs.length} jobs scheduled`}
            >
              {dayJobs.length}
            </span>
          )}
          {/* Quick-add: drops a New Job straight onto this date. Always visible
              on mobile (no hover there); hover-reveal on desktop to keep the
              grid clean until you reach for it. */}
          {onQuickAdd && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onQuickAdd(date) }}
              className="grid place-items-center w-5 h-5 rounded text-ink-3 hover:text-indigo-600 hover:bg-indigo-500/10 transition-opacity sm:opacity-0 sm:group-hover/day:opacity-100 focus:opacity-100"
              title="Add a job on this day"
              aria-label={`Add a job on ${date}`}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {dayBookings.length > 0 && !isMobile && (
        <div className="text-[10px] text-orange-600/70 mb-0.5 truncate leading-tight">
          {isCheckin && '> '}
          {dayBookings[0].property_name || 'Guest'}
          {isCheckout && ' (out)'}
        </div>
      )}

      {daySkips.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-panel text-purple-700 dark:text-purple-300 border-hairline line-through truncate leading-tight"
          title={`${daySkips.length} occurrence(s) skipped on this date${daySkips[0].reason ? ': ' + daySkips[0].reason : ''}`}
        >
          <Ban className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">skipped</span>
        </div>
      )}

      {dayReschedFrom.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-panel text-purple-600 dark:text-purple-300 border-hairline italic truncate leading-tight"
          title={`Moved to ${dayReschedFrom[0].rescheduled_date}`}
        >
          <ArrowRight className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">→ {dayReschedFrom[0].rescheduled_date?.slice(5)}</span>
        </div>
      )}

      {dayReschedTo.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-panel text-purple-700 dark:text-purple-300 border-hairline truncate leading-tight"
          title={`Moved from ${dayReschedTo[0].exception_date}`}
        >
          <ArrowLeft className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">moved</span>
        </div>
      )}

      {/* Mobile: a 52px-wide cell can't fit "10:00 · Name" pills, so show
          density as colored dots (by service type) + an overflow count. The
          whole cell taps to open the day's full list (onSelectDay). */}
      {isMobile && dayJobs.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {dayJobs.slice(0, 5).map(j => {
            const tc = typeConfig[j.job_type] || typeConfig.residential
            return <span key={j.id}
              className={`w-2 h-2 rounded-full ${tc.dot} ${j.status === 'cancelled' ? 'opacity-30' : ''}`} />
          })}
          {dayJobs.length > 5 && (
            <span className="text-[9px] font-bold text-ink-3 leading-none">+{dayJobs.length - 5}</span>
          )}
        </div>
      )}

      {!isMobile && (
      <div className="space-y-1">
        {shownJobs.map(j => {
          const tc = typeConfig[j.job_type] || typeConfig.residential
          const chipTime = j.start_time ? j.start_time.slice(0, 5) : ''
          const chipWho = j.client_name || (j.address ? j.address.split(',')[0] : '') || j.title
          const isDuplicate = j.job_type === 'str_turnover' && j.property_id &&
            dayJobs.filter(dj => dj.job_type === 'str_turnover' && dj.property_id === j.property_id).length > 1
          const isCancelled = j.status === 'cancelled'
          const crew = cleanerFor ? cleanerFor(j) : null
          const needsCleaner = !isCancelled && !crew
          return (
            <div
              key={j.id}
              draggable={!isMobile}
              onDragStart={e => onChipDragStart(e, j)}
              onDragEnd={onChipDragEnd}
              onTouchStart={e => onChipTouchStart(e, j)}
              onTouchMove={onChipTouchMove}
              onTouchEnd={onChipTouchEnd}
              onTouchCancel={onChipTouchCancel}
              style={{ touchAction: 'none' }}
              onClick={e => {
                // Suppress the synthetic click that fires after a touch-drag.
                if (justDraggedRef.current) {
                  justDraggedRef.current = false
                  e.stopPropagation()
                  return
                }
                e.stopPropagation()
                onJobClick?.(j)
              }}
              className={`group/chip block overflow-hidden pl-1.5 pr-1.5 py-1 rounded-md leading-tight cursor-grab active:cursor-grabbing transition-colors ${
                isCancelled ? 'bg-bg-2 text-ink-3 line-through' :
                isDuplicate ? 'bg-panel border border-red-300 text-red-700 dark:border-red-500/40' :
                'bg-panel border border-hairline hover:bg-bg-2'
              }`}
              title={`${chipTime ? chipTime + ' · ' : ''}${j.title}${j.client_name ? ' · ' + j.client_name : ''}${crew ? ' · assigned' : ' · needs a cleaner'}${j.recurring_schedule_id ? ' (recurring)' : ''} — press-and-hold to reschedule`}
            >
              {/* Two lines: WHO on top at full width, everything else below.
                  One line could never fit dot+time+icons+name+badge in a
                  ~125px month cell — the name always lost and the owner saw
                  a wall of bare times ("10:00 S…"). The name is the thing
                  she scans for; it gets the whole first line. */}
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tc.dot}`} />
                {isDuplicate && <span className="shrink-0 text-red-500" title="Duplicate turnover detected">⚠</span>}
                <span className="flex-1 min-w-0 truncate text-[12px] text-ink font-medium">{chipWho}</span>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px] text-ink-2">
                {chipTime && <span className="font-semibold tabular-nums shrink-0">{chipTime}</span>}
                {j.is_immediate_turnover && (
                  <Zap className="w-2.5 h-2.5 shrink-0 text-red-600" title="Immediate turnover — same-day check-in" />
                )}
                {!j.is_immediate_turnover && j.turnover_lead_warning && (
                  <Zap className="w-2.5 h-2.5 shrink-0 text-amber-600"
                       title={`Tight turnaround — only ~${Math.max(0, Math.round(j.turnover_lead_hours))}h before the next guest checks in`} />
                )}
                {j.recurring_schedule_id && <RotateCw className="w-2.5 h-2.5 shrink-0 opacity-50" title="Recurring" />}
                <span className="flex-1" />
                {!isCancelled && (
                  crew ? (
                    <span className="shrink-0 inline-flex items-center justify-center h-[15px] min-w-[15px] px-1 rounded-full bg-ink/5 dark:bg-white/10 text-[8px] font-semibold text-ink-2 leading-none"
                      title={`Assigned${crew.count > 1 ? ` · ${crew.count} cleaners` : ''}`}>
                      {crew.initials}{crew.count > 1 ? `+${crew.count - 1}` : ''}
                    </span>
                  ) : (
                    // Calm "needs a cleaner" cue — a soft amber dot instead of a
                    // loud circled "?" on every unassigned job (the screenful of
                    // question marks the operator was drowning in).
                    <span className="shrink-0 w-[7px] h-[7px] rounded-full bg-amber-400 ring-2 ring-amber-200/70 dark:ring-amber-500/25"
                      title="Needs a cleaner" />
                  )
                )}
              </div>
            </div>
          )
        })}
        {/* "+N more" expands the day INLINE (the row grows to fit) so nothing
            is hidden — click it again (now "Show less") to collapse. Works on
            touch, unlike the old hover popover. Audit §10. */}
        {hiddenCount > 0 && !isExpanded && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleMore?.(date) }}
            className="text-[9px] sm:text-[10px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline px-0.5 sm:px-1 py-0.5 w-full text-left"
          >
            +{hiddenCount} more
          </button>
        )}
        {isExpanded && dayJobs.length > maxPills && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleMore?.(date) }}
            className="flex items-center gap-0.5 text-[9px] sm:text-[10px] font-medium text-ink-3 hover:text-ink-2 px-0.5 sm:px-1 py-0.5 w-full text-left"
          >
            <ChevronUp className="w-2.5 h-2.5" /> Show less
          </button>
        )}
      </div>
      )}
    </div>
  )
}

export default memo(MonthDayCell)
