import { iconChipClass } from './iconChip'

/**
 * PageHeader — the standard top-of-page header.
 *
 * Replaces the hand-rolled `<h1>` + subtitle + actions blocks each page wrote
 * its own way (and often with hard-coded zinc colors that didn't theme). Uses
 * design tokens so it adapts to light / dark / alternate themes.
 *
 *   <PageHeader title="Invoices" subtitle="42 total" icon={FileText}
 *     iconColor="emerald" actions={<Button>New invoice</Button>} />
 *
 * `iconColor` is one of the semantic keys in `iconChip.js` (blue, violet,
 * purple, amber, emerald, rose, cyan, slate) — renders as a tinted chip
 * behind the icon (Twenty/Notion-style), with a soft glow under the Neon
 * theme. `actions` renders right-aligned on the same row; on narrow screens
 * it wraps underneath. `children` renders below the header row (e.g. a tabs
 * strip).
 */
export default function PageHeader({
  title,
  subtitle,
  icon: Icon,
  iconColor = 'blue',
  actions,
  className = '',
  children,
}) {
  return (
    <div className={`px-4 sm:px-8 pt-4 sm:pt-5 pb-3 ${className}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && (
            <span className={`bb-icon-chip grid place-items-center w-9 h-9 rounded-xl shrink-0 ${iconChipClass(iconColor)}`}>
              <Icon className="w-[18px] h-[18px]" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-ink tracking-tight truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs sm:text-[13px] text-ink-3 mt-0.5">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}
