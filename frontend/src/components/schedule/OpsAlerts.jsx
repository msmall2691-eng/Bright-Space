/**
 * Ops alerts — the two things you might need to act on right now.
 *
 * Quiet hairline cards (the owner vetoed the solid yellow banners): a small
 * colored dot carries the severity, the text stays in ink, and the actions
 * are ordinary small secondary buttons. Complementary to the toolbar filter
 * counters — this names the specific offenders inline.
 *
 *   - "N jobs need a crew · at 10:00, 14:00"  [Assign] [Open to crew]
 *   - "Today is 92% booked · consider moving one to tomorrow"
 *
 * "Open to crew" flips open_for_claims on the still-unassigned jobs so they
 * show on every cleaner's phone with a Claim button (crew app Phase 3) —
 * the same toggle JobDetail carries, surfaced where the office actually
 * sees the gap. Renders nothing when there's nothing to say.
 */

const BTN =
  'shrink-0 px-2.5 py-1.5 rounded-md bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 text-xs font-medium transition-colors'

export default function OpsAlerts({ stats, unassignedToday, onFocusUnassigned, onOpenToCrew }) {
  const alerts = []
  if (stats?.unassigned > 0) {
    // Name up to two by their times so the alert reads specifically
    // ("at 14:00, 16:00") — anonymous counts wear out fast.
    const previews = (unassignedToday || []).slice(0, 2)
      .map(v => (v.start_time || '').slice(0, 5))
      .filter(Boolean)
    // Jobs already opened to crew don't need opening again.
    const claimable = (unassignedToday || []).filter(v => !v.open_for_claims)
    alerts.push({
      key: 'unassigned',
      dot: 'bg-amber-500',
      title: `${stats.unassigned} job${stats.unassigned === 1 ? '' : 's'} need${stats.unassigned === 1 ? 's' : ''} a crew`,
      detail: previews.length ? `at ${previews.join(', ')}` : null,
      actions: [
        onFocusUnassigned && { label: 'Assign', onClick: onFocusUnassigned },
        onOpenToCrew && claimable.length > 0 && {
          label: 'Open to crew',
          onClick: () => onOpenToCrew(claimable),
          title: 'Let cleaners claim these jobs from their phone',
        },
      ].filter(Boolean),
    })
  }
  if (stats && stats.jobs > 0 && stats.capacityPct >= 90) {
    alerts.push({
      key: 'capacity',
      dot: 'bg-blue-500',
      title: `Today is ${stats.capacityPct}% booked`,
      detail: 'consider moving one to tomorrow',
      actions: [],
    })
  }

  if (alerts.length === 0) return null

  return (
    <div className="px-3 pt-1 pb-2 space-y-1.5">
      {alerts.map(a => (
        <div
          key={a.key}
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2 min-h-[44px] rounded-lg border border-hairline bg-panel text-[12.5px]"
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.dot}`} aria-hidden="true" />
          <span className="flex-1 min-w-0 leading-snug text-ink">
            <span className="font-medium">{a.title}</span>
            {a.detail && <span className="ml-1 text-ink-3">· {a.detail}</span>}
          </span>
          {a.actions.map(act => (
            <button key={act.label} type="button" onClick={act.onClick} title={act.title} className={BTN}>
              {act.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
