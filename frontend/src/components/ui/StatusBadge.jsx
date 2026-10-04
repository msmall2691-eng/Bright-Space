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
const DOTS = {
  success: 'bg-emerald-500 dark:bg-emerald-400',
  warning: 'bg-amber-500 dark:bg-amber-400',
  danger: 'bg-red-500 dark:bg-red-400',
  info: 'bg-blue-500 dark:bg-blue-400',
  neutral: 'bg-ink-3',
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
