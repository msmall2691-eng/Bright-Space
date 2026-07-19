/**
 * Seven-day chip strip with per-day load bars.
 *
 * The old month-grid landing view left "how packed is this week" as a
 * click-through-each-day exercise. The load bar under each date makes
 * a week's shape scannable at a thumb tap. Sunday-first (US convention).
 */
import { toLocalYMD } from '../../utils/format'

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function DateStrip({ weekDates, loadByDate, currentDate, onSelect, todayStr }) {
  const selectedYMD = toLocalYMD(currentDate)
  return (
    <div className="px-3 pt-1 pb-2">
      <div className="grid grid-cols-7 gap-1">
        {weekDates.map(d => {
          const info = loadByDate[d] || { jobs: 0, capacityPct: 0 }
          const dayNum = Number(d.slice(-2))
          const dowIdx = new Date(`${d}T12:00`).getDay()
          const isSelected = d === selectedYMD
          const isToday = d === todayStr
          return (
            <button
              key={d}
              type="button"
              onClick={() => onSelect(new Date(`${d}T12:00`))}
              className={`flex flex-col items-center justify-center py-2 rounded-xl border transition-colors ${
                isSelected
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : isToday
                    ? 'bg-bg-2 border-hairline text-ink'
                    : 'bg-transparent border-transparent text-ink-3 hover:bg-bg-2'
              }`}
              aria-label={`${DOW_LABEL[dowIdx]} ${dayNum}, ${info.jobs} job${info.jobs === 1 ? '' : 's'}`}
              aria-current={isSelected ? 'date' : undefined}
            >
              <span className={`text-[9.5px] font-mono tracking-wider uppercase ${isSelected ? 'opacity-80' : 'opacity-70'}`}>
                {DOW_LABEL[dowIdx]}
              </span>
              <span className="text-[17px] font-semibold tabular-nums leading-tight mt-0.5">
                {dayNum}
              </span>
              <span
                className={`block mt-1.5 h-[3px] w-[60%] max-w-[32px] rounded-full overflow-hidden relative ${
                  isSelected ? 'bg-white/30' : 'bg-hairline'
                }`}
                aria-hidden="true"
              >
                <span
                  className={`absolute top-0 left-0 h-full rounded-full ${
                    isSelected
                      ? 'bg-white'
                      : info.capacityPct >= 85
                        ? 'bg-amber-500'
                        : info.capacityPct > 0
                          ? 'bg-blue-500'
                          : ''
                  }`}
                  style={{ width: `${info.capacityPct}%` }}
                />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
