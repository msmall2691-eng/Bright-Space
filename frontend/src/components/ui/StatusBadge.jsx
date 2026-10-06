/**
 * StatusBadge — a bare dot + word. A small colored dot carries the status hue;
 * the label text always rides alongside it, so status never relies on color
 * alone. No bordered box, no fill: the owner rejected even the quiet boxed
 * "dot-pill" (Oct 2026 — "those little bubbles") and asked status to recede
 * into the text. See the brightbase-design-language skill.
 *
 * Same API as before ({status, variant, children}); `variant` is accepted for
 * compatibility but there is one shape now.
 */
import { STATUS_DOT } from '../../theme/statusDots'

// BB-A11Y-02. These five ARE the app's severity vocabulary, so this is the
// highest-leverage place the measured steps belong: every consumer of
// StatusBadge inherits the fix. The light 500s were all under the 3:1
// non-text floor against this app's own grounds (emerald 2.09, amber 1.77,
// red 2.55, blue 2.98) — the dark 400s already cleared and are unchanged.
const DOTS = {
  success: STATUS_DOT.ok,
  warning: STATUS_DOT.attention,
  danger: STATUS_DOT.problem,
  info: STATUS_DOT.info,
  neutral: STATUS_DOT.neutral,
}

export default function StatusBadge({
  status,
  variant, // eslint-disable-line no-unused-vars -- legacy prop; one shape now
  className = '',
  children,
}) {
  const dot = DOTS[status] || DOTS.neutral
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium leading-none text-ink-2 ${className}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {children}
    </span>
  )
}
