// Maps a domain status word (quote / invoice / job / opportunity / …) to a
// StatusBadge semantic tone, so the quiet dot+word badge carries the right hue
// everywhere without each caller re-deriving it. Unknown → neutral.
const TONE = {
  // neutral / not-yet-started
  draft: 'neutral', archived: 'neutral', unscheduled: 'neutral', new: 'neutral',
  // in flight
  sent: 'info', viewed: 'info', converted: 'info', scheduled: 'info',
  dispatched: 'info', qualified: 'info', quoted: 'info',
  // needs attention
  in_progress: 'warning', expired: 'warning', changes_requested: 'warning',
  // done / good
  accepted: 'success', paid: 'success', completed: 'success', won: 'success',
  active: 'success',
  // bad / ended
  overdue: 'danger', declined: 'danger', cancelled: 'danger', lost: 'danger',
}

export function statusTone(status) {
  return TONE[String(status || '').toLowerCase()] || 'neutral'
}

// The human label for a status word: underscores → spaces (StatusBadge / CSS
// `capitalize` handles the casing).
export function statusLabel(status) {
  return String(status || '').replace(/_/g, ' ')
}
