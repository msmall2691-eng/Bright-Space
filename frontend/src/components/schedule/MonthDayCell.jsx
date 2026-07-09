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
import { Ban, ArrowRight, ArrowLeft, Zap, RotateCw } from 'lucide-react'

function MonthDayCell({
  date, dayJobs, dayBookings, daySkips, dayReschedFrom, dayReschedTo,
  isToday, isSelected, isDropTarget, isCheckin, isCheckout,
  isMobile, maxPills, typeConfig,
  onSelectDay, onDragOverDay, onDragLeaveDay, onDropDay,
  onChipDragStart, onChipDragEnd,
  onChipTouchStart, onChipTouchMove, onChipTouchEnd, onChipTouchCancel,
  onJobClick, justDraggedRef,
}) {
  return (
    <div
      data-day-cell={date}
      onClick={() => onSelectDay(date)}
      onDragOver={e => onDragOverDay(e, date)}
      onDragLeave={onDragLeaveDay}
      onDrop={e => onDropDay(e, date)}
      className={`relative p-1 sm:p-1.5 min-h-[64px] sm:min-h-[80px] cursor-pointer transition-colors ${
        isDropTarget ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset' :
        isSelected ? 'bg-blue-50/60' :
        dayBookings.length > 0 ? 'bg-orange-50/50 hover:bg-orange-50' :
        'bg-panel hover:bg-bg'
      }`}
    >
      {/* Day header — date circle + a small density chip on packed days so
          the operator reads volume at a glance without having to fan out
          the chips or open the day panel. Audit §10: month cells hide most
          of a busy day. */}
      <div className="flex items-center justify-between mb-0.5 sm:mb-1">
        <div className={`text-[10px] sm:text-xs font-semibold w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full ${
          isToday ? 'bg-blue-500 text-white' :
          isSelected ? 'text-blue-600' :
          'text-ink-2'
        }`}>
          {parseInt(date.slice(8))}
        </div>
        {dayJobs.length > maxPills && (
          <span
            className="hidden sm:inline text-[9px] font-semibold text-ink-3 bg-bg-2 border border-hairline rounded-full px-1.5 leading-4"
            title={`${dayJobs.length} jobs scheduled`}
          >
            {dayJobs.length}
          </span>
        )}
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
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50/60 text-purple-700 border-purple-200 line-through truncate leading-tight"
          title={`${daySkips.length} occurrence(s) skipped on this date${daySkips[0].reason ? ': ' + daySkips[0].reason : ''}`}
        >
          <Ban className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">skipped</span>
        </div>
      )}

      {dayReschedFrom.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50/40 text-purple-600 border-purple-200 italic truncate leading-tight"
          title={`Moved to ${dayReschedFrom[0].rescheduled_date}`}
        >
          <ArrowRight className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">→ {dayReschedFrom[0].rescheduled_date?.slice(5)}</span>
        </div>
      )}

      {dayReschedTo.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50 text-purple-700 border-purple-300 truncate leading-tight"
          title={`Moved from ${dayReschedTo[0].exception_date}`}
        >
          <ArrowLeft className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">moved</span>
        </div>
      )}

      <div className="space-y-0.5">
        {dayJobs.slice(0, maxPills).map(j => {
          const tc = typeConfig[j.job_type] || typeConfig.residential
          const chipTime = j.start_time ? j.start_time.slice(0, 5) : ''
          const chipWho = j.client_name || (j.address ? j.address.split(',')[0] : '') || j.title
          const isDuplicate = j.job_type === 'str_turnover' && j.property_id &&
            dayJobs.filter(dj => dj.job_type === 'str_turnover' && dj.property_id === j.property_id).length > 1
          const isCancelled = j.status === 'cancelled'
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
              className={`flex items-center gap-1 text-[10px] sm:text-[11px] px-1 sm:px-1.5 py-0.5 rounded border leading-tight cursor-grab active:cursor-grabbing ${
                isCancelled ? 'bg-bg-2 text-ink-3 border-hairline line-through' :
                isDuplicate ? 'bg-red-50 text-red-700 border-red-300 ring-1 ring-red-200' :
                `${tc.pill} ${tc.pillHover}`
              }`}
              title={`${chipTime ? chipTime + ' · ' : ''}${j.title}${j.client_name ? ' · ' + j.client_name : ''}${j.recurring_schedule_id ? ' (recurring)' : ''} — press-and-hold to reschedule`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tc.dot}`} />
              {isDuplicate && <span className="shrink-0 text-red-500" title="Duplicate turnover detected">⚠</span>}
              {j.is_immediate_turnover && (
                <Zap className="w-2.5 h-2.5 shrink-0 text-red-600" title="Immediate turnover — same-day check-in" />
              )}
              {!j.is_immediate_turnover && j.turnover_lead_warning && (
                <Zap className="w-2.5 h-2.5 shrink-0 text-amber-600"
                     title={`Tight turnaround — only ~${Math.max(0, Math.round(j.turnover_lead_hours))}h before the next guest checks in`} />
              )}
              {j.recurring_schedule_id && <RotateCw className="w-2.5 h-2.5 shrink-0 opacity-60" />}
              {chipTime && <span className="font-semibold tabular-nums shrink-0">{chipTime}</span>}
              <span className="truncate">{chipWho}</span>
            </div>
          )
        })}
        {dayJobs.length > maxPills && (
          // Group wraps the "+N more" button + a hover popover. The popover
          // lists the HIDDEN jobs at full width, wrapped (no truncation),
          // so a packed day is inspectable without opening the day panel.
          // Click still opens the day panel (works on touch, no hover).
          // Audit §10.
          <div className="relative group/more">
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onSelectDay(date) }}
              className="text-[9px] sm:text-[10px] font-medium text-blue-600 hover:text-blue-700 hover:underline px-0.5 sm:px-1 py-0.5 w-full text-left"
            >
              +{dayJobs.length - maxPills} more
            </button>
            <div
              className="hidden group-hover/more:block absolute z-30 left-0 top-full mt-1 w-56 max-w-[16rem] bg-panel rounded-lg shadow-xl border border-hairline p-2"
              onClick={e => e.stopPropagation()}
              role="tooltip"
            >
              <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-1.5">
                {dayJobs.length - maxPills} more · {new Date(date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </div>
              <div className="space-y-0.5 max-h-72 overflow-auto">
                {dayJobs.slice(maxPills).map(j2 => {
                  const tc2 = typeConfig[j2.job_type] || typeConfig.residential
                  const chipTime2 = j2.start_time ? j2.start_time.slice(0, 5) : ''
                  const chipWho2 = j2.client_name || (j2.address ? j2.address.split(',')[0] : '') || j2.title
                  const isCancelled2 = j2.status === 'cancelled'
                  return (
                    <button
                      key={j2.id}
                      type="button"
                      onClick={e => { e.stopPropagation(); onJobClick?.(j2) }}
                      className={`w-full text-left flex items-center gap-1 text-[11px] px-1.5 py-1 rounded border leading-tight ${
                        isCancelled2 ? 'bg-bg-2 text-ink-3 border-hairline line-through' :
                        `${tc2.pill} ${tc2.pillHover}`
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tc2.dot}`} />
                      {chipTime2 && <span className="font-semibold tabular-nums shrink-0">{chipTime2}</span>}
                      <span className="whitespace-normal break-words">{chipWho2}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(MonthDayCell)
