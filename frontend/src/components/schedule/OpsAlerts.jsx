/**
 * Ops alerts — the two things you might need to act on right now.
 *
 * The existing ScheduleHealthStrip surfaces "N not on Google" /
 * "N unassigned" as filter counters. This card row is complementary: it
 * names the *specific* offenders inline and lets you one-tap toward them
 * (turn on the filter, jump to the queue).
 *
 * Renders nothing when there's nothing to say — no chrome for a clean day.
 */
import { AlertCircle, Info } from 'lucide-react'

export default function OpsAlerts({ stats, unassignedToday, onFocusUnassigned }) {
  const alerts = []
  if (stats?.unassigned > 0) {
    // Name up to two by their times so the alert reads specifically
    // ("14:00 Beach House, 16:00 Salt Cottage") — anonymous counts wear
    // out fast.
    const previews = unassignedToday.slice(0, 2)
      .map(v => (v.start_time || '').slice(0, 5))
      .filter(Boolean)
    alerts.push({
      key: 'unassigned',
      tone: 'warn',
      title: `${stats.unassigned} job${stats.unassigned === 1 ? '' : 's'} need${stats.unassigned === 1 ? 's' : ''} a crew`,
      detail: previews.length ? `at ${previews.join(', ')}` : null,
      cta: 'Assign',
      onClick: onFocusUnassigned,
    })
  }
  if (stats && stats.jobs > 0 && stats.capacityPct >= 90) {
    alerts.push({
      key: 'capacity',
      tone: 'info',
      title: `Today is ${stats.capacityPct}% booked`,
      detail: 'consider moving one to tomorrow',
      cta: null,
    })
  }

  if (alerts.length === 0) return null

  return (
    <div className="px-3 pt-1 pb-2 space-y-1.5">
      {alerts.map(a => {
        const Icon = a.tone === 'warn' ? AlertCircle : Info
        return (
          <div
            key={a.key}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border text-[12.5px] ${
              a.tone === 'warn'
                ? 'bg-amber-50 border-amber-200 text-amber-900'
                : 'bg-blue-50 border-blue-200 text-blue-900'
            }`}
          >
            <Icon className={`w-3.5 h-3.5 shrink-0 ${a.tone === 'warn' ? 'text-amber-500' : 'text-blue-500'}`} />
            <span className="flex-1 leading-snug">
              <strong className="font-semibold">{a.title}</strong>
              {a.detail && (
                <span className={`ml-1 ${a.tone === 'warn' ? 'text-amber-700' : 'text-indigo-700'}`}>
                  · {a.detail}
                </span>
              )}
            </span>
            {a.cta && a.onClick && (
              <button
                type="button"
                onClick={a.onClick}
                className={`text-[10.5px] font-mono tracking-widest uppercase font-semibold ${
                  a.tone === 'warn' ? 'text-amber-800 hover:text-amber-900' : 'text-blue-800 hover:text-blue-900'
                }`}
              >
                {a.cta}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
