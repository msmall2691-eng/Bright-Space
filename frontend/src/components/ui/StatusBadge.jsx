/**
 * StatusBadge — the Attio-style dot-pill: a quiet bordered body with a small
 * colored dot carrying the status hue, instead of a tinted capsule. Status
 * still never relies on color alone — the label text is always present.
 *
 * Same API as before ({status, variant, children}); `variant` is accepted
 * for compatibility but both variants now render the one pill shape.
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
      className={`inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium leading-none text-ink-2 ${className}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {children}
    </span>
  )
}
